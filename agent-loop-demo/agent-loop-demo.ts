/** Trace one "query -> answer" turn through the agent loop, then steer, follow up, and stop a runaway tool loop. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

const log = (msg: string) => { console.log(msg) }

/** A model that replays a fixed script and records every request it receives. */
class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly script: StreamChunk[][] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    assert.ok(entry, 'the scripted model ran out of replies')
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
const callTool = (rawId: string, name: string, args: object): StreamChunk[] => {
  const id = ToolCallId(rawId)
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

// 第 3 步要在工具执行期间插话：给工具一个可选的闸门。
let gate: Promise<void> | undefined
let concludeOnCall = false
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

await ctx.fiber.dispose()
process.exit(0)
