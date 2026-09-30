/** Trace one "query -> answer" turn through the agent loop, then steer, follow up, and stop a runaway tool loop. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as checkpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'

const log = (msg: string) => { console.log(msg) }

/** One scripted reply: fixed chunks, or a generator for replies that must wait on something. */
type Entry = StreamChunk[] | ((options: GenerateOptions) => AsyncIterable<StreamChunk>)
/** A model that replays a fixed script and records every request it receives. */
class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly script: Entry[] = []
  constructor(readonly contextWindow?: number) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const context = this.contextWindow === undefined ? {} : { context: { contextWindow: this.contextWindow } }
    return Promise.resolve({ provider, id: model, name: model, ...context })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.purpose === 'compaction') {
      yield* reply('## Primary Request and Intent\n- check every service')
      return
    }
    const entry = this.script.shift()
    assert.ok(entry, 'the scripted model ran out of replies')
    if (typeof entry === 'function') {
      yield* entry(options)
      return
    }
    for (const chunk of entry) yield chunk
  }
}
const reply = (text: string): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const callTool = (rawId: string, name: string, args: object): StreamChunk[] => callTools([[rawId, name, args]])
/** Several tool calls in one assistant message, in model order. */
const callTools = (calls: [string, string, object][]): StreamChunk[] => [
  ...calls.flatMap(([rawId, name, args], index): StreamChunk[] => {
    const id = ToolCallId(rawId)
    const json = JSON.stringify(args)
    return [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name, argumentsDelta: json },
      { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: json } },
    ]
  }),
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

// 第 3 步要在工具执行期间插话：给工具一个可选的闸门。
let gate: Promise<void> | undefined
let concludeOnCall = false
const lineOutput = {
  schema: { type: 'object', additionalProperties: false, properties: { line: { type: 'string', required: true } } },
  render: (_args: unknown, value: { line: string }) => [{ type: 'text' as const, text: value.line }],
} as const
const lookupRelease = defineTool({
  name: 'lookup_release',
  description: 'Query the latest synthetic release of one service.',
  parameters: { service: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { line: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: value.line }],
  },
  async execute(args, exec) {
    await gate
    if (concludeOnCall) exec.concludeTurn()
    return { line: args.service === 'payment-api' ? 'demo-003 payment-api failed, rolled back' : `demo-007 ${args.service} succeeded` }
  },
})

const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
const model = new ScriptedModel()
ctx.llm.registerAdapter(['mock'], model)
ctx.tools.register(lookupRelease)
await ctx.plugin(AgentLoop, { agents: [] })

// 时间线：会话事件带 seq，钩子用 [hook] 标出。
const timeline: string[] = []
let tracing = false
const mark = (line: string) => { if (tracing) timeline.push(line) }
ctx.on('session/event', (_session, e) => {
  const extra = e.type === 'turn/end' ? `(${e.data.reason.kind})`
    : e.type === 'step/start' || e.type === 'step/end' ? ` step ${e.data.step}`
      : e.type === 'user/message' ? ` ${JSON.stringify(textOf(e.data.content))}`
        : ''
  mark(`seq ${String(e.seq).padStart(2)} ${e.type}${extra}`)
})
ctx.on('agent/status', ({ status }) => { mark(`  ~ agent/status ${status}`) })
ctx.on('system-prompt/assemble', async (_assembly, _context, next) => { mark('  [hook] system-prompt/assemble'); return next() })
ctx.on('agent/pre-step', async ({ step }, next) => { mark(`  [hook] agent/pre-step (step ${step})`); return next() })
ctx.on('agent/request', async (_payload, next) => { mark('  [hook] agent/request'); return next() })
ctx.on('llm/stream', (_options, next) => { mark('  [hook] llm/stream'); return next() })
ctx.on('tools/pre-execute', async (exec, next) => { mark(`  [hook] tools/pre-execute ${exec.name}`); return next() })
ctx.on('tools/post-execute', async (exec, _result, next) => { mark(`  [hook] tools/post-execute ${exec.name}`); return next() })
let stopping = 0
ctx.on('agent/turn-stopping', () => { stopping++; mark('  [hook] agent/turn-stopping') })

const textOf = (content: readonly { type: string; text?: string }[]) => content.map(b => b.text ?? '').join('')
const agentOptions = { provider: 'mock', model: 'mock' }
const idle = (a: Agent) => new Promise<void>((resolve) => {
  const off = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject === a && status === 'idle') { off(); resolve() }
  })
})
const say = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
// oxlint-disable-next-line typescript/no-deprecated -- the demo reads the whole log on purpose
const events = (a: Agent): readonly SessionEvent[] => a.session.snapshotEvents()
const turnEnds = (a: Agent) => events(a).filter(e => e.type === 'turn/end')
  .map(e => e.type === 'turn/end' ? `turn ${e.data.turn}: ${e.data.reason.kind}` : '')
const stepsIn = (a: Agent, turn: number) => events(a).filter(e => e.type === 'step/start' && e.data.turn === turn).length

/** A second context with the same core plugins; optional persistence and compaction for steps 10-11. */
const newCtx = async (m: ScriptedModel, opts: { root?: string; compaction?: boolean } = {}) => {
  const c = new Context()
  await c.plugin(LlmRuntime)
  await c.plugin(SessionStore)
  await c.plugin(SessionProjectionRegistry)
  await c.plugin(SystemPrompt)
  await c.plugin(ToolRuntime)
  await c.plugin(AgentRegistry)
  if (opts.root !== undefined) {
    await c.plugin(JsonlSessionPersistence, { root: opts.root, compression: 'none' })
    await c.plugin(checkpointPolicy)
  }
  if (opts.compaction) {
    await c.plugin(TokenMeter)
    await c.plugin(ToolResultPruner, { thresholdChars: 1200, headChars: 600, tailChars: 200 })
    await c.plugin(BasicCompactionEngine, {})
  }
  c.llm.registerAdapter(['mock'], m)
  c.tools.register(lookupRelease)
  await c.plugin(AgentLoop, { agents: [] })
  return c
}

if (process.argv[2] === 'inbox-child') {
  // 子进程：第一轮的工具卡住，趁机 followup 第二个问题，刷盘后等父进程来杀。
  const m = new ScriptedModel()
  const c = await newCtx(m, { root: process.argv[3] })
  const { agent: a } = await c.agents.create({ sessionId: SessionId('oncall-inbox'), agentOptions })
  gate = new Promise(() => {})
  m.script.push(callTool('call-q1', 'lookup_release', { service: 'payment-api' }))
  const started = new Promise<void>((resolve) => {
    const off = c.on('tools/pre-execute', async (_exec, next) => { off(); resolve(); return next() })
  })
  a.followup(say('payment-api 最近一次发布怎么样？'))
  await started
  a.followup(say('order-api 呢？'))
  await c.sessions.flush(a.session)
  process.stdout.write('QUEUED\n')
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}

log('1. one turn, "query -> answer": every hook and every logged event in order')
const { agent } = await ctx.agents.create({ sessionId: SessionId('oncall-trace'), agentOptions })
model.script.push(callTool('call-1', 'lookup_release', { service: 'payment-api' }), reply('demo-003 失败并已回滚。'))
tracing = true
let done = idle(agent)
agent.followup(say('payment-api 最近一次发布怎么样？'))
await done
tracing = false
for (const line of timeline) log(`  ${line}`)
const types = events(agent).map(e => e.type)
assert.deepEqual(types.filter(t => ['turn/start', 'step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end', 'turn/end'].includes(t)), [
  'turn/start', 'step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
  'step/start', 'assistant/message', 'step/end', 'turn/end',
])
assert.equal(timeline.filter(l => l.includes('[hook] llm/stream')).length, 2, 'two steps, two model calls')
assert.equal(timeline.filter(l => l.includes('turn-stopping')).length, 1, 'turn-stopping fires once, after the answering step')
const at = (s: string) => timeline.findIndex(l => l.includes(s))
assert.ok(at('turn-stopping') < at('turn/end'))
// step/start 先于 agent/request，系统提示词与用户消息在 agent/request 之后才写入；第二步不再写 system/message。
assert.ok(at('step/start step 1') < at('[hook] agent/request') && at('[hook] agent/request') < at('system/message') && at('system/message') < at('user/message'))
assert.equal(timeline.filter(l => l.includes('system/message')).length, 1)
assert.ok(at('seq  9 tool/call') < at('tools/pre-execute'))

log('2. the second request is derived from the log, not kept in memory')
const [first, second] = model.requests
assert.ok(first && second)
const roles = (r: GenerateOptions) => r.messages.map(m => m.role).join(' ')
log(`  request 1: ${first.messages.length} messages [${roles(first)}], ${first.tools?.length ?? 0} tool schema(s)`)
log(`  request 2: ${second.messages.length} messages [${roles(second)}]`)
log(`  request keys: ${Object.keys(second).sort().join(', ')}`)
log(`  request 2 messages deep-equal session.deriveMessages(): ${JSON.stringify(second.messages) === JSON.stringify(agent.session.deriveMessages().slice(0, second.messages.length))}; every message frozen: ${Object.isFrozen(second.messages) && second.messages.every(m => Object.isFrozen(m))}`)
const toolAnswer = second.messages.at(-1)
log(`  last message of request 2: role ${toolAnswer?.role}, blocks [${toolAnswer?.content.map(b => b.type).join(', ')}]`)
assert.equal(roles(second), 'system user assistant user')
assert.deepEqual(toolAnswer?.content.map(b => b.type), ['tool-result'])
assert.ok(!('system' in second))
assert.ok(Object.isFrozen(second.messages) && second.messages.every(m => Object.isFrozen(m)))
assert.equal(JSON.stringify(second.messages), JSON.stringify(agent.session.deriveMessages().slice(0, second.messages.length)))

log('3. steer vs followup while a tool is running')
const steerDemo = (await ctx.agents.create({ sessionId: SessionId('oncall-steer'), agentOptions })).agent
const release = Promise.withResolvers<void>()
gate = release.promise
model.script.push(
  callTool('call-2', 'lookup_release', { service: 'payment-api' }),
  reply('payment-api 回滚了；order-api 我也会看。'),
  reply('order-api 最近一次是 demo-007，成功。'),
)
done = idle(steerDemo)
const toolStarted = new Promise<void>((resolve) => {
  const off = ctx.on('tools/pre-execute', async (_exec, next) => { off(); resolve(); return next() })
})
steerDemo.followup(say('payment-api 怎么样？'))
await toolStarted
steerDemo.steer(say('顺便也看看 order-api'))
steerDemo.followup(say('order-api 呢？'))
gate = undefined
release.resolve()
await done
const where = (text: string) => {
  const e = events(steerDemo).find(x => x.type === 'user/message' && textOf(x.data.content) === text)
  assert.ok(e?.type === 'user/message')
  const step = [...events(steerDemo)].reverse().find(x => x.seq < e.seq && x.type === 'step/start')
  assert.ok(step?.type === 'step/start')
  return { turn: step.data.turn, step: step.data.step, seq: e.seq }
}
const steered = where('顺便也看看 order-api')
const followed = where('order-api 呢？')
log(`  steer    "顺便也看看 order-api" -> seq ${steered.seq}, turn ${steered.turn} step ${steered.step} (same turn, next step)`)
log(`  followup "order-api 呢？"        -> seq ${followed.seq}, turn ${followed.turn} step ${followed.step} (a new turn)`)
log(`  ${turnEnds(steerDemo).join('; ')}`)
assert.deepEqual([steered.turn, steered.step, followed.turn, followed.step], [1, 2, 2, 1])

log('4. a model that keeps calling tools: nothing stops the turn by default')
const runaway = (await ctx.agents.create({ sessionId: SessionId('oncall-runaway'), agentOptions })).agent
for (let i = 1; i <= 25; i++) model.script.push(callTool(`loop-${i}`, 'lookup_release', { service: `svc-${i}` }))
model.script.push(reply('查完了 25 个服务。'))
stopping = 0
done = idle(runaway)
runaway.followup(say('把所有服务都查一遍'))
await done
log(`  ${stepsIn(runaway, 1)} steps, ${events(runaway).filter(e => e.type === 'tool/call').length} tool calls in turn 1; agent/turn-stopping fired ${stopping} time(s), after the last step`)
const lastRunaway = model.requests.at(-1)
log(`  every step re-sends the whole history: the 26th request carried ${lastRunaway?.messages.length} messages`)
assert.deepEqual([stepsIn(runaway, 1), stopping, lastRunaway?.messages.length], [26, 1, 2 + 2 * 25])

log('5. three ways to stop it: reject the step, cancel from a hook, or conclude from inside the tool')
// 结尾展示跳过收件箱的 splice 事件。
const tail = (a: Agent) => events(a).filter(e => e.type !== 'agent/inbox/spliced').slice(-3, -1).map(e => e.type).join(' > ')
const budget = (await ctx.agents.create({ sessionId: SessionId('oncall-budget'), agentOptions })).agent
const wrapUp = '先停一下，汇总已经查到的'
// 第 3 次工具调用执行时 steer 一条消息，它会被第 4 步领取，而第 4 步随即被拒绝。
const offSteer = ctx.on('tools/pre-execute', async (exec, next) => {
  if (exec.callId === 'budget-3') budget.steer(say(wrapUp))
  return next()
})
let claimedByRejected: string[] = []
const offBudget = ctx.on('agent/pre-step', async (payload, next) => {
  if (payload.agent === budget && payload.step > 3) {
    claimedByRejected = payload.messages.map(m => textOf(m.content))
    return { kind: 'reject' }
  }
  return next()
})
for (let i = 1; i <= 10; i++) model.script.push(callTool(`budget-${i}`, 'lookup_release', { service: `svc-${i}` }))
stopping = 0
const before = model.requests.length
done = idle(budget)
budget.followup(say('把所有服务都查一遍'))
await done
offBudget()
offSteer()
const inHistory = events(budget).some(e => e.type === 'user/message' && textOf(e.data.content) === wrapUp)
log(`  agent/pre-step rejects step 4 -> ${turnEnds(budget).join('; ')}; ${model.requests.length - before} model calls; turn-stopping ${stopping}`)
log(`    log ends ${tail(budget)} > turn/end: the step-3 tool result is never answered`)
log(`    steered during step 3, claimed by the rejected step 4: ${JSON.stringify(claimedByRejected)}`)
log(`    afterwards in history: ${inHistory}; still pending: ${budget.inbox.nextStep.length + budget.inbox.nextTurn.length > 0}; event before turn/end: ${events(budget).at(-2)?.type}`)
assert.deepEqual([turnEnds(budget), model.requests.length - before, stopping, tail(budget)], [['turn 1: blocked'], 3, 0, 'tool/result > step/end'])
assert.deepEqual([claimedByRejected, inHistory, budget.inbox.nextStep.length + budget.inbox.nextTurn.length, events(budget).at(-2)?.type], [[wrapUp], false, 0, 'agent/inbox/spliced'])
model.script.splice(0)

const cancelled = (await ctx.agents.create({ sessionId: SessionId('oncall-cancel'), agentOptions })).agent
const offCancel = ctx.on('agent/pre-step', async (payload, next) => {
  if (payload.agent === cancelled && payload.step > 3) payload.agent.cancel({ kind: 'hook', reason: 'step budget' })
  return next()
})
for (let i = 1; i <= 10; i++) model.script.push(callTool(`cancel-${i}`, 'lookup_release', { service: `svc-${i}` }))
stopping = 0
const beforeCancel = model.requests.length
done = idle(cancelled)
cancelled.followup(say('把所有服务都查一遍'))
await done
offCancel()
const cancelEnd = events(cancelled).at(-1)
assert.ok(cancelEnd?.type === 'turn/end' && cancelEnd.data.reason.kind === 'aborted')
const cause = cancelEnd.data.reason.reason
log(`  agent.cancel() in agent/pre-step at step 4 -> turn 1: aborted (${cause.kind}${cause.kind === 'hook' ? `: ${cause.reason}` : ''}); ${model.requests.length - beforeCancel} model calls; turn-stopping ${stopping}`)
log(`    log ends ${tail(cancelled)} > turn/end`)
assert.deepEqual([cause, model.requests.length - beforeCancel, stopping, tail(cancelled)], [{ kind: 'hook', reason: 'step budget' }, 3, 0, 'tool/result > step/end'])
model.script.splice(0)

const concluding = (await ctx.agents.create({ sessionId: SessionId('oncall-conclude'), agentOptions })).agent
concludeOnCall = true
model.script.push(callTool('conclude-1', 'lookup_release', { service: 'payment-api' }))
stopping = 0
const beforeConclude = model.requests.length
done = idle(concluding)
concluding.followup(say('查一下 payment-api 就停'))
await done
concludeOnCall = false
log(`  tool calls exec.concludeTurn() -> ${turnEnds(concluding).join('; ')}; ${model.requests.length - beforeConclude} model call; turn-stopping ${stopping}`)
log(`    log ends ${tail(concluding)} > turn/end: the model never saw the result`)
assert.deepEqual([turnEnds(concluding), model.requests.length - beforeConclude, stopping, tail(concluding)], [['turn 1: completed'], 1, 1, 'tool/result > step/end'])

const kinds = (list: readonly SessionEvent[]) => list.filter(e => e.type !== 'agent/inbox/spliced')
  .map(e => e.type === 'turn/end' ? `turn/end(${e.data.reason.kind})` : e.type === 'step/start' ? `step/start ${e.data.step}` : e.type)
// 只看骨架：略去请求头、请求上下文和系统提示词。
const brief = (list: readonly SessionEvent[]) => kinds(list).filter(k => !['request/header', 'request/context', 'system/message'].includes(k))
const waitSettled = async (a: Agent) => {
  // 驱动可能在一轮结束后自己再开一轮：等状态连续 3 次（约 120ms）都是 idle。
  for (let quiet = 0; quiet < 3;) {
    await sleep(40)
    quiet = a.status === 'idle' ? quiet + 1 : 0
  }
}

log('6. cancel inside agent/request: the step started, but no system prompt or user message was committed')
const early = (await ctx.agents.create({ sessionId: SessionId('oncall-early-cancel'), agentOptions })).agent
const offEarly = ctx.on('agent/request', async (payload, next) => {
  if (payload.agent === early) early.cancel({ kind: 'hook', reason: 'cancel before request' })
  return next()
})
done = idle(early)
early.followup(say('payment-api 最近一次发布怎么样？'))
await done
offEarly()
log(`  ${kinds(events(early)).join(' > ')}`)
log(`  system/message or user/message in the log: ${events(early).some(e => e.type === 'system/message' || e.type === 'user/message')}; inbox pending: ${early.inbox.nextStep.length + early.inbox.nextTurn.length}`)
assert.deepEqual(kinds(events(early)), ['turn/start', 'step/start 1', 'step/end', 'turn/end(aborted)'])

log('7. a prompt that changes between steps is re-committed at step 2')
const dyn = (await ctx.agents.create({ sessionId: SessionId('oncall-prompt'), agentOptions })).agent
let assembled = 0
const offSection = ctx.systemPrompt.section({ name: 'demo:assembly-clock', order: 10_000, text: c => c.agent === dyn ? `Assembly #${++assembled}` : '' })
model.script.push(callTool('call-p', 'lookup_release', { service: 'payment-api' }), reply('demo-003 失败并已回滚。'))
done = idle(dyn)
dyn.followup(say('payment-api 最近一次发布怎么样？'))
await done
offSection()
const sysAt = events(dyn).filter(e => e.type === 'system/message').map(e => {
  const step = [...events(dyn)].reverse().find(x => x.seq < e.seq && x.type === 'step/start')
  return `seq ${e.seq} (step ${step?.type === 'step/start' ? step.data.step : '?'}, ${JSON.stringify(e.surfaceOp)})`
})
log(`  system/message: ${sysAt.join(', ')}`)
assert.equal(sysAt.length, 2)
assert.ok(sysAt[1]?.includes('step 2') && sysAt[1].includes('"replace"'))

log('8. two parallel-safe calls in one message: the slow first call is still committed first')
const finished: string[] = []
ctx.tools.register(defineTool({
  name: 'probe_release',
  description: 'Probe one service (safe to run in parallel).',
  parameters: { service: { type: 'string', required: true } },
  isConcurrencySafe: () => true,
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { line: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: value.line }],
  },
  async execute(args) {
    await sleep(args.service === 'slow-api' ? 80 : 5)
    finished.push(args.service)
    return { line: `${args.service} ok` }
  },
}))
const par = (await ctx.agents.create({ sessionId: SessionId('oncall-parallel'), agentOptions })).agent
model.script.push(callTools([['p-1', 'probe_release', { service: 'slow-api' }], ['p-2', 'probe_release', { service: 'fast-api' }]]), reply('两个都正常。'))
done = idle(par)
par.followup(say('同时探一下 slow-api 和 fast-api'))
await done
log(`  finished executing: ${finished.join(', ')}`)
const order8 = events(par).filter(e => e.type === 'tool/call' || e.type === 'tool/result').map(e => `${e.type} ${e.type === 'tool/call' ? e.data.callId : e.data.message.source.callId}`)
log(`  log: ${order8.join(' > ')}`)
assert.deepEqual(finished, ['fast-api', 'slow-api'], 'the two calls really overlapped')
assert.deepEqual(order8, ['tool/call p-1', 'tool/call p-2', 'tool/result p-1', 'tool/result p-2'])

log('9. request/header is rewritten only when the envelope changes')
const hdr = (await ctx.agents.create({ sessionId: SessionId('oncall-header'), agentOptions })).agent
const headersIn = (a: Agent, turn: number) => {
  const list = events(a)
  const start = list.findIndex(e => e.type === 'turn/start' && e.data.turn === turn)
  const end = list.findIndex(e => e.type === 'turn/end' && e.data.turn === turn)
  return list.slice(start, end).filter(e => e.type === 'request/header').map(e => e.type === 'request/header' ? e.data.reason : '')
}
const askHdr = async (text: string) => { model.script.push(reply('好的。')); done = idle(hdr); hdr.followup(say(text)); await done }
await askHdr('第 1 个问题')
await askHdr('第 2 个问题')
const offExtra = ctx.tools.register(defineTool({ name: 'extra_tool', description: 'An extra tool.', parameters: {}, output: lineOutput, async execute() { return { line: 'ok' } } }))
await askHdr('第 3 个问题（新注册了一个工具）')
const offModel = ctx.on('agent/request', async (payload, next) => {
  const config = await next()
  return payload.agent === hdr ? { ...config, model: 'mock-large' } : config
})
await askHdr('第 4 个问题（换了模型）')
offModel()
void offExtra
for (let t = 1; t <= 4; t++) log(`  turn ${t}: request/header ${JSON.stringify(headersIn(hdr, t))}`)
assert.deepEqual([1, 2, 3, 4].map(t => headersIn(hdr, t)), [['initial'], [], ['change'], ['change']])

log('10. the inbox is in the log: kill -9 with a queued followup, then resume in a new context')
const dir10 = mkdtempSync(join(tmpdir(), 'dsh-agent-loop-demo-'))
process.once('exit', () => { rmSync(dir10, { recursive: true, force: true }) })
const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), 'inbox-child', dir10], { stdio: ['ignore', 'pipe', 'inherit'] })
process.prependOnceListener('exit', () => { child.kill('SIGKILL') })
await new Promise<void>((resolve) => { child.stdout.on('data', (d: Buffer) => { if (d.toString().includes('QUEUED')) resolve() }) })
const exited = new Promise<NodeJS.Signals | null>((resolve) => { child.once('exit', (_c, signal) => { resolve(signal) }) })
child.kill('SIGKILL')
log(`  child killed while lookup_release hung (${String(await exited)}); "order-api 呢？" was queued behind it`)
const m10 = new ScriptedModel()
const c10 = await newCtx(m10, { root: dir10 })
m10.script.push(reply('order-api 最近一次是 demo-007，成功。'), reply('还在，刚才进程重启过。'))
const { agent: r10 } = await c10.agents.resume({ resumeSessionId: SessionId('oncall-inbox'), agentOptions })
const turns10 = () => kinds(events(r10)).filter(k => k.startsWith('turn/end'))
log(`  right after resume: next-turn inbox ${JSON.stringify(r10.inbox.nextTurn.map(m => textOf(m.content)))}; ${turns10().join(', ')}`)
await sleep(300)
log(`  300ms later: status ${r10.status}, model calls ${m10.requests.length}; the restored message waits for a wake-up`)
r10.followup(say('还在吗？'))
await waitSettled(r10)
const asked10 = events(r10).filter(e => e.type === 'user/message').map(e => e.type === 'user/message' ? textOf(e.data.content) : '')
log(`  after a new followup: user messages ${JSON.stringify(asked10)}; ${turns10().join(', ')}`)
assert.deepEqual(asked10, ['payment-api 最近一次发布怎么样？', 'order-api 呢？', '还在吗？'])
assert.deepEqual(turns10(), ['turn/end(interrupted)', 'turn/end(completed)', 'turn/end(completed)'])

log('11. compaction inside a turn does not end it')
const m11 = new ScriptedModel(2000)
const c11 = await newCtx(m11, { compaction: true })
const big = (await c11.agents.create({ sessionId: SessionId('oncall-compact'), agentOptions })).agent
c11.tools.register(defineTool({
  name: 'fetch_log', description: 'Fetch a long synthetic log.', parameters: { service: { type: 'string', required: true } }, output: lineOutput,
  async execute(args) { return { line: Array.from({ length: 50 }, (_, i) => `${args.service} line ${i} ok`).join('\n') } },
}))
for (let i = 1; i <= 12; i++) m11.script.push(callTool(`big-${i}`, 'fetch_log', { service: `svc-${i}` }))
m11.script.push(reply('12 个服务的日志都看过了。'))
const done11 = new Promise<void>((resolve) => { const off = c11.on('agent/status', ({ agent: a, status }) => { if (a === big && status === 'idle') { off(); resolve() } }) })
big.followup(say('把 12 个服务的日志都拉一遍'))
await done11
const ev11 = events(big)
const compStep = [...ev11].reverse().find(e => e.type === 'step/start' && e.seq < (ev11.find(x => x.type === 'compaction/summary')?.seq ?? -1))
log(`  ${ev11.filter(e => e.type === 'compaction/prune').length} prunes, ${ev11.filter(e => e.type === 'compaction/summary').length} summaries; first summary during step ${compStep?.type === 'step/start' ? compStep.data.step : '?'}`)
const ends11 = ev11.filter(e => e.type === 'turn/end').map(e => e.type === 'turn/end' ? e.data.reason.kind : '')
log(`  turn 1: ${ev11.filter(e => e.type === 'step/start').length} steps, ${ends11.join(', ')}`)
assert.ok(ev11.some(e => e.type === 'compaction/summary'))
assert.deepEqual([ev11.filter(e => e.type === 'step/start').length, ends11], [13, ['completed']])

log('12. an answer cut at the output cap ends the turn as max-tokens')
const capped = (await ctx.agents.create({ sessionId: SessionId('oncall-max-tokens'), agentOptions })).agent
model.script.push([
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'payment-api 最近 40 次发布里，失败的有 demo-004、demo-011、' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'payment-api 最近 40 次发布里，失败的有 demo-004、demo-011、' } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
  { type: 'finish', reason: { kind: 'max-tokens' } },
])
stopping = 0
done = idle(capped)
capped.followup(say('列出 payment-api 所有失败的发布'))
await done
log(`  ${brief(events(capped)).join(' > ')}; turn-stopping ${stopping}`)
assert.deepEqual([kinds(events(capped)).at(-1), stopping], ['turn/end(max-tokens)', 1])

log('13. a turn-stopping listener that steers keeps the turn going')
const stopper = (await ctx.agents.create({ sessionId: SessionId('oncall-stop-hook'), agentOptions })).agent
let vetoes = 0
const offVeto = ctx.on('agent/turn-stopping', ({ agent: a }) => {
  if (a === stopper && vetoes++ === 0) a.steer(say('先别停，再确认一下 order-api'))
})
model.script.push(reply('payment-api 回滚了。'), reply('order-api 也正常。'))
stopping = 0
done = idle(stopper)
stopper.followup(say('payment-api 怎么样？'))
await done
offVeto()
log(`  ${brief(events(stopper)).join(' > ')}; turn-stopping ${stopping}`)
assert.deepEqual([stepsIn(stopper, 1), stopping, kinds(events(stopper)).at(-1)], [2, 2, 'turn/end(completed)'])

log('14. concludeTurn() does not end the turn when context or a steer is waiting')
const concl2 = (await ctx.agents.create({ sessionId: SessionId('oncall-conclude-ctx'), agentOptions })).agent
concludeOnCall = true
const offCtx = ctx.on('tools/post-execute', async (exec, _result, next) => {
  const decision = await next()
  if (exec.callId !== 'cc-1' || decision.kind !== 'accept') return decision
  return { ...decision, additionalContexts: [say('提醒：同一个服务已经查过 1 次。')] }
})
model.script.push(callTool('cc-1', 'lookup_release', { service: 'payment-api' }), reply('收到提醒，结束。'))
stopping = 0
done = idle(concl2)
concl2.followup(say('查一下 payment-api 就停'))
await done
offCtx()
log(`  with additionalContexts: ${brief(events(concl2)).join(' > ')}; turn-stopping ${stopping}`)
assert.deepEqual([stepsIn(concl2, 1), stopping], [2, 1])
const concl3 = (await ctx.agents.create({ sessionId: SessionId('oncall-conclude-steer'), agentOptions })).agent
const offSteer3 = ctx.on('tools/pre-execute', async (exec, next) => {
  if (exec.callId === 'cs-1') concl3.steer(say('顺便看看 order-api'))
  return next()
})
model.script.push(callTool('cs-1', 'lookup_release', { service: 'payment-api' }), reply('order-api 也看了。'))
stopping = 0
done = idle(concl3)
concl3.followup(say('查一下 payment-api 就停'))
await done
offSteer3()
concludeOnCall = false
log(`  with a steer during the tool: ${brief(events(concl3)).join(' > ')}; turn-stopping ${stopping}`)
assert.deepEqual([stepsIn(concl3, 1), stopping], [2, 1])

log('15. reject step 4, but put the claimed steer back first; a followup queued meanwhile')
const kept = (await ctx.agents.create({ sessionId: SessionId('oncall-reject-restore'), agentOptions })).agent
const offSteer15 = ctx.on('tools/pre-execute', async (exec, next) => {
  if (exec.callId === 'rr-3') { kept.steer(say(wrapUp)); kept.followup(say('另外 order-api 呢？')) }
  return next()
})
const offReject15 = ctx.on('agent/pre-step', async (payload, next) => {
  if (payload.agent === kept && payload.turn === 1 && payload.step > 3) {
    for (const m of [...payload.messages].reverse()) kept.inbox.prepend('next-step', m)
    return { kind: 'reject' }
  }
  return next()
})
for (let i = 1; i <= 3; i++) model.script.push(callTool(`rr-${i}`, 'lookup_release', { service: `svc-${i}` }))
kept.followup(say('把所有服务都查一遍'))
await waitSettled(kept)
offSteer15()
offReject15()
const pending15 = (a: Agent) => `next-step ${JSON.stringify(a.inbox.nextStep.map(m => textOf(m.content)))}, next-turn ${JSON.stringify(a.inbox.nextTurn.map(m => textOf(m.content)))}`
log(`  ${kinds(events(kept)).filter(k => k.startsWith('turn/') || k.startsWith('step/start')).join(' > ')}; status ${kept.status}`)
log(`    still queued: ${pending15(kept)}`)
assert.equal(pending15(kept), `next-step ${JSON.stringify([wrapUp])}, next-turn ${JSON.stringify(['另外 order-api 呢？'])}`)
model.script.push(reply('先汇总：3 个服务都成功；order-api 也成功。'), reply('继续查剩下的。'))
const before15 = model.requests.length
kept.followup(say('继续'))
await waitSettled(kept)
const turn2req = model.requests[before15]
log(`  after followup "继续": ${kinds(events(kept)).filter(k => k.startsWith('turn/end')).join(', ')}`)
log(`    turn 2's request ends with: ${turn2req?.messages.slice(-4).map(m => `${m.role}[${m.content.map(b => b.type === 'text' ? JSON.stringify(b.text) : b.type).join(',')}]`).join(' ')}`)
assert.deepEqual([kept.inbox.nextStep.length, kept.inbox.nextTurn.length], [0, 0])
assert.deepEqual(kinds(events(kept)).filter(k => k.startsWith('turn/end')), ['turn/end(blocked)', 'turn/end(completed)', 'turn/end(completed)'])
assert.deepEqual(turn2req?.messages.slice(-4).map(m => m.content.map(b => b.type === 'text' ? b.text : b.type).join()), ['tool-call', 'tool-result', wrapUp, '另外 order-api 呢？'])

log('16. cancel mid-stream, and cancel while the first of two calls runs')
const streaming = (await ctx.agents.create({ sessionId: SessionId('oncall-stream-cancel'), agentOptions })).agent
const midStream = Promise.withResolvers<void>()
model.script.push(async function * (options) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'payment-api 最近一次发布 demo-003' }
  midStream.resolve()
  await new Promise(resolve => options.signal?.addEventListener('abort', resolve))
})
done = idle(streaming)
streaming.followup(say('payment-api 怎么样？'))
await midStream.promise
streaming.cancel({ kind: 'user' })
await done
const cut = events(streaming).find(e => e.type === 'assistant/message')
log(`  ${brief(events(streaming)).join(' > ')}`)
log(`    assistant/message interrupted=${String(cut?.type === 'assistant/message' && cut.data.interrupted)}: ${JSON.stringify(cut?.type === 'assistant/message' ? textOf(cut.data.message.content) : '')}`)
assert.ok(cut?.type === 'assistant/message' && cut.data.interrupted === true)
assert.equal(kinds(events(streaming)).at(-1), 'turn/end(aborted)')
const twoCalls = (await ctx.agents.create({ sessionId: SessionId('oncall-two-calls'), agentOptions })).agent
const offCancel16 = ctx.on('tools/pre-execute', async (exec, next) => {
  if (exec.callId === 'tc-1') twoCalls.cancel({ kind: 'user' })
  return next()
})
model.script.push(callTools([['tc-1', 'lookup_release', { service: 'payment-api' }], ['tc-2', 'lookup_release', { service: 'order-api' }]]))
done = idle(twoCalls)
twoCalls.followup(say('payment-api 和 order-api 都查一下'))
await done
offCancel16()
const results16 = events(twoCalls).filter(e => e.type === 'tool/result').map(e => e.type === 'tool/result' ? `${e.data.message.source.callId} ${e.data.error?.code ?? 'ok'}` : '')
log(`  two exclusive calls, cancel in tc-1's pre-execute: ${results16.join(', ')}; ${kinds(events(twoCalls)).at(-1)}`)
assert.deepEqual(results16, ['tc-1 ABORTED_BEFORE_DISPATCH', 'tc-2 ABORTED_BEFORE_DISPATCH'])

log('17. cancel() clears queued messages unless keepInbox is set')
for (const keepInbox of [false, true]) {
  const a = (await ctx.agents.create({ sessionId: SessionId(`oncall-cancel-keep-${keepInbox}`), agentOptions })).agent
  const hold = Promise.withResolvers<void>()
  gate = hold.promise
  const started = new Promise<void>((resolve) => {
    const off = ctx.on('tools/pre-execute', async (_exec, next) => { off(); resolve(); return next() })
  })
  model.script.push(callTool(`k-${keepInbox}`, 'lookup_release', { service: 'payment-api' }))
  if (keepInbox) model.script.push(reply('order-api 最近一次是 demo-007，成功。'))
  a.followup(say('payment-api 怎么样？'))
  await started
  a.followup(say('order-api 呢？'))
  a.cancel({ kind: 'user' }, { keepInbox })
  gate = undefined
  hold.resolve()
  await waitSettled(a)
  log(`  keepInbox ${String(keepInbox).padEnd(5)}: ${kinds(events(a)).filter(k => k.startsWith('turn/')).join(' > ')}; pending ${a.inbox.nextStep.length + a.inbox.nextTurn.length}`)
  assert.equal(a.inbox.nextStep.length + a.inbox.nextTurn.length, keepInbox ? 1 : 0)
  model.script.splice(0)
}

await Promise.all([c10, c11].map(c => c.fiber.dispose()))
await ctx.fiber.dispose()
process.exit(0)
