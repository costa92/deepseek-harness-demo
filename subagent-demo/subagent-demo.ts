/** Delegate one release check per service through dsh-subagent's spawn and fork providers, then collect the results. */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolRestriction } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as CheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ForkProvider from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as ToolSubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import ApprovalService from '@deepseek-ai/dsh-user-approval'

const log = (msg: string) => { console.log(msg) }

// ── 脚本化模型：父 agent 按轮取动作，子 agent 按任务文字决定动作 ─────────────
type Action = () => StreamChunk[]
const textOf = (message: Message | undefined) => (message?.content ?? [])
  .map(b => b.type === 'text' ? b.text : b.type === 'tool-result' ? b.content.map(c => c.type === 'text' ? c.text : '').join('') : '')
  .join('')
const isToolResult = (message: Message | undefined) => message?.content.some(b => b.type === 'tool-result') === true
const TASK = /^(查|回滚|再派|分派|审批) (\S+)$/
/** The delegated task is the first text block of a user message; continuable children get return guidance appended as a second block. */
const taskOf = (messages: Message[]) => messages.flatMap(m => {
  const first = m.role === 'user' ? m.content[0] : undefined
  return first?.type === 'text' && TASK.test(first.text) ? [first.text] : []
}).at(0)

interface ChildRequest { task: string; taskBlocks: string[]; tools: string[]; messages: string[]; runtime: string }
class ScriptedModel extends LlmAdapter {
  /** Parent turns keyed by session id; a turn starts on a text-only user message. */
  readonly parents = new Map<string, Action[][]>()
  private readonly current = new Map<string, Action[]>()
  readonly childFirst = new Map<string, ChildRequest>()
  readonly parentRequests = new Map<string, number>()
  /** Every child request's message summaries, keyed by child session id. */
  readonly childRequests = new Map<string, string[][]>()
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sid = String(options.sessionId)
    const last = options.messages.at(-1)
    const turns = this.parents.get(sid)
    if (turns !== undefined) {
      this.parentRequests.set(sid, (this.parentRequests.get(sid) ?? 0) + 1)
      if (!isToolResult(last)) this.current.set(sid, turns.shift() ?? [])
      const action = this.current.get(sid)?.shift()
      assert.ok(action, `parent ${sid} has no action for: ${textOf(last).slice(0, 60)}`)
      for (const chunk of action()) yield chunk
      return
    }
    const task = taskOf(options.messages)
    assert.ok(task, `child ${sid} has no task`)
    const summary = options.messages.map(m => `${m.role}: ${textOf(m).split('\n')[0]}`)
    this.childRequests.set(sid, [...this.childRequests.get(sid) ?? [], summary])
    if (!this.childFirst.has(sid)) {
      const taskMessage = options.messages.find(m => m.role === 'user' && m.content[0]?.type === 'text' && m.content[0].text === task)
      this.childFirst.set(sid, {
        task,
        taskBlocks: (taskMessage?.content ?? []).map(b => b.type === 'text' ? b.text : ''),
        tools: (options.tools ?? []).map(t => t.name),
        messages: summary,
        runtime: options.messages.map(textOf).find(x => x.startsWith('Current runtime context.')) ?? '',
      })
    }
    for (const chunk of childStep(task, options.messages)) yield chunk
  }
}
const reply = (text: string): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
  { type: 'finish', reason: { kind: 'stop' } },
]
let callSeq = 0
/** One assistant message carrying every listed tool call, the way a model fans out. */
const calls = (...list: [string, object][]): StreamChunk[] => [
  ...list.flatMap(([name, args], index): StreamChunk[] => {
    const id = ToolCallId(`call-${++callSeq}`)
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
const fanout: { text: string; isError: boolean }[] = []
function childStep(task: string, messages: Message[]): StreamChunk[] {
  const [, verb, target] = TASK.exec(task) ?? []
  assert.ok(verb !== undefined && target !== undefined)
  const last = messages.at(-1)
  if (verb === '分派') {
    // 结果回来之后（包括孙 agent 的结束通知唤醒的轮次）只回一句，不再派。
    const results = messages.flatMap(m => m.content.flatMap(b => b.type === 'tool-result' ? [b] : []))
    if (results.length > 0) {
      if (fanout.length === 0) fanout.push(...results.map(b => ({ text: b.content.map(c => c.type === 'text' ? c.text : '').join(''), isError: b.isError === true })))
      return reply('收到。')
    }
    return calls(...Array.from({ length: Number(target) }, (_, i): [string, object] =>
      ['subagent_deep', { description: `grandchild ${i + 1}`, prompt: `查 svc-g${i + 1}` }]))
  }
  if (isToolResult(last)) return reply(textOf(last))
  if (verb === '查') return calls(['lookup_release', { service: target }])
  if (verb === '回滚') return calls(['rollback_release', { service: target }])
  if (verb === '审批') return calls(['risky_op', { service: target }])
  return calls(['subagent', { description: 'nested check', prompt: `查 ${target}`, run_in_background: false }])
}

// ── 业务工具：合成的发布记录，查询有延迟，好观察并发 ─────────────────────────
const RELEASES: Record<string, [string, number]> = {
  'order-api': ['demo-007 succeeded', 40],
  'payment-api': ['demo-003 failed, rolled back', 200],
  'user-api': ['demo-011 succeeded', 360],
}
let inflight = 0
let peak = 0
let gate: Promise<void> | undefined
const lookupRelease = defineTool({
  name: 'lookup_release',
  description: 'Query the latest synthetic release of one service.',
  parameters: { service: { type: 'string', required: true } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute(args, exec) {
    inflight++
    peak = Math.max(peak, inflight)
    try {
      const [result, delay] = RELEASES[args.service] ?? ['unknown service', 10]
      // gate 只卡 svc-* 这类批量服务，第 7 步池满时还要能查 order-api。
      await (gate !== undefined && args.service.startsWith('svc-') ? gate : new Promise(resolve => setTimeout(resolve, delay)))
      exec.signal.throwIfAborted()
      return `${args.service}: ${result}`
    } finally {
      inflight--
    }
  },
})
const pauseMs = defineTool({
  name: 'pause_ms',
  description: 'Wait the given number of milliseconds.',
  parameters: { ms: { type: 'number', required: true } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute(args) {
    await new Promise(resolve => setTimeout(resolve, args.ms))
    return `paused ${args.ms}ms`
  },
})
/** A tool that asks for approval; records the outcome and the caller's delegated policy events. */
const approvals: { agent: string; outcome: string; policy: string[] }[] = []
const riskyOp = defineTool({
  name: 'risky_op',
  description: 'An operation that needs user approval.',
  parameters: { service: { type: 'string', required: true } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute(args, exec) {
    const agent = exec.agent
    assert.ok(agent)
    const outcome = await ctx.approval.request({ agent, toolName: 'risky_op', signal: exec.signal })
    approvals.push({
      agent: agent.id,
      outcome,
      policy: events(agent).flatMap(e => e.type === 'sandbox/mode' ? [`sandbox/mode ${e.data.mode} source=${e.data.source}`]
        : e.type === 'approval/policy' ? [`approval/policy ${e.data.policy} source=${e.data.source}`] : []),
    })
    return `${args.service}: approval ${outcome}`
  },
})
const rollbacks: string[] = []
const rollbackRelease = defineTool({
  name: 'rollback_release',
  description: 'Roll one service back to its previous synthetic release.',
  parameters: { service: { type: 'string', required: true } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute(args) {
    rollbacks.push(args.service)
    return Promise.resolve(`${args.service} rolled back`)
  },
})

// ── preset：一个空的默认 preset，一个在 preset 里拉黑回滚的巡检 preset ──────
const root = await mkdtemp(join(tmpdir(), 'dsh-subagent-demo-'))
// 断言失败时也要清掉临时目录。
process.on('exit', () => { rmSync(root, { recursive: true, force: true }) })
process.env.DSH_HOME = join(root, 'home')
const presets = join(root, 'presets')
const rows = fileURLToPath(new URL('./oncall-rows.ts', import.meta.url))
async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(presets, path)), { recursive: true })
  await writeFile(join(presets, path), text)
}
await put('general/agent.cordis.yml', `- id: rows\n  name: ${rows}\n  config:\n    tools: []\n`)
await put('joined/agent.cordis.yml', [
  '- id: rows',
  `  name: ${rows}`,
  '  config:',
  '    tools: []',
  '    allowOnJoin: [lookup_release, subagent]',
].join('\n'))
await put('patrol/agent.cordis.yml', [
  '- id: rows',
  `  name: ${rows}`,
  '  config:',
  '    tools: []',
  '    restrict: { deny: [rollback_release] }',
].join('\n'))

// ── 宿主：与 base bundle 相同的两行委派工具，外加一个带 toolFilter 的 ────────
const ctx = new Context()
// 包名行按 baseUrl 解析，与第 17 篇的 demo 相同。
ctx.baseUrl = pathToFileURL(fileURLToPath(new URL('../../apps/cli/', import.meta.url))).href
await ctx.plugin(Loader)
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
await ctx.plugin(CheckpointPolicy)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'query.db') })
await ctx.plugin(AgentPresets, { default: 'general', roots: [{ path: presets, trust: 'system' }], includeShippedRoot: false, includeUserRoot: false })
await ctx.plugin(SubagentRuntime)
await ctx.plugin(SpawnProvider, { providerName: 'spawn' })
await ctx.plugin(ForkProvider, { providerName: 'fork' })
await ctx.plugin(ToolSubagentControl)
await ctx.plugin(ToolSubagent, { provider: 'spawn', toolName: 'subagent', backgroundMode: 'continuable' })
await ctx.plugin(ToolSubagent, { provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'one-shot' })
await ctx.plugin(ToolSubagent, { provider: 'spawn', toolName: 'subagent_safe', toolFilter: { deny: ['rollback_release'] } })
await ctx.plugin(ToolSubagent, { provider: 'spawn', toolName: 'subagent_deep', backgroundMode: 'continuable', maxDepth: 2 })
const model = new ScriptedModel()
ctx.llm.registerAdapter(['mock'], model)
ctx.tools.register(lookupRelease)
ctx.tools.register(rollbackRelease)
ctx.tools.register(pauseMs)
ctx.tools.register(riskyOp)

const headers = new Map<string, SessionHeader>()
ctx.on('subagent/start', ({ id }) => {
  const header = ctx.agents.get(id)?.session.header
  if (header !== undefined) headers.set(id, header)
})

const tops: Agent[] = []
/** Create a top-level session the way a host factory does: join a preset in `setup`, optionally mask at agent scope. */
async function open(id: string, turns: Action[][], preset = 'general', agentMask?: ToolRestriction): Promise<Agent> {
  model.parents.set(id, turns)
  const { agent } = await ctx.agents.create({
    sessionId: SessionId(id),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx: Context) => {
      await ctx.agentPresets.mount(agentCtx, preset)
      if (agentMask !== undefined) agentCtx.tools.restrict(agentMask)
    },
  })
  tops.push(agent)
  return agent
}
const human = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
/** Wait until no child is live, every top-level agent is idle, and `until` holds. */
async function settle(until: () => boolean = () => true): Promise<void> {
  const deadline = Date.now() + 10_000
  const done = () => ctx.agents.list().length === tops.length
    && tops.every(a => a.status === 'idle' && turnsOpen(a) === 0) && until()
  while (!done()) {
    assert.ok(Date.now() < deadline, `still live: ${ctx.agents.list().map(a => `${a.id}:${a.status}`).join(', ')}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(done())
}
// oxlint-disable-next-line typescript/no-deprecated -- the demo reads the whole log on purpose
const events = (agent: Agent): readonly SessionEvent[] => agent.session.snapshotEvents()
const toolResults = (agent: Agent) => events(agent).flatMap(e => e.type === 'tool/result'
  ? e.data.message.content.flatMap(b => b.type === 'tool-result' ? [{ text: b.content.map(c => c.type === 'text' ? c.text : '').join(''), isError: b.isError === true }] : [])
  : [])
/** Turns started but not yet ended; a woken parent can report idle before its turn/end lands. */
const turnsOpen = (agent: Agent) => events(agent).reduce((n, e) => n + (e.type === 'turn/start' ? 1 : e.type === 'turn/end' ? -1 : 0), 0)
const liveChildren = () => ctx.agents.list().length - tops.length
const settledNotices = (agent: Agent) => events(agent)
  .filter(e => e.type === 'user/message' && e.data.source.kind === 'subagent-settled').length
/** Child ids are random UUIDs; print the task each child was given instead. */
const taskName = (id: string) => model.childFirst.get(id)?.task.split(' ')[1] ?? id
const named = (text: string) => text.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, id => `<${taskName(id)}>`)
const SERVICES = Object.keys(RELEASES)
/** Children created in the same millisecond are ordered by their random ids; sort by label for a stable printout. */
const childrenOf = async (id: string) => (await ctx.subagents.listChildren(SessionId(id)))
  .flatMap(e => e.kind === 'child' ? [e] : []).sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''))

log('== 1. 默认的 subagent：派出去就返回，结果靠通知送回 ==')
const patrol = await open('patrol', [
  [
    () => calls(...SERVICES.map((s): [string, object] => ['subagent', { description: `check ${s}`, prompt: `查 ${s}` }])),
    () => reply('3 个子 agent 已派出，等它们的结果。'),
  ],
  ...SERVICES.map(() => [() => reply('收到一份结果。')]),
])
patrol.followup(human('查一下 3 个服务最近一次发布'))
// 最后一条结束通知在子 agent 离开注册表之后才送到，所以按通知条数等。
await settle(() => settledNotices(patrol) === 3)
for (const r of toolResults(patrol)) log(`subagent -> ${named(r.text)}`)
const notices = events(patrol).flatMap(e => e.type === 'user/message' && e.data.source.kind === 'subagent-settled'
  ? [e.data.content.map(b => b.type === 'text' ? b.text : '')] : [])
log(`通知首行：${named(notices[0]?.[0] ?? '')}`)
for (const [, , closing] of notices) log(`  结尾文本：${closing}`)
const patrolTurns = events(patrol).filter(e => e.type === 'turn/end').length
log(`子 agent 查询最多同时 ${peak} 个在跑；父 agent 共 ${patrolTurns} 轮，其中 ${patrolTurns - 1} 轮由通知唤醒`)
const patrolChildren = await childrenOf('patrol')
log(`还活着的子 agent ${liveChildren()} 个；留下的子会话：${patrolChildren.map(e => `${e.mode}/${e.activity}`).join(', ')}`)
assert.equal(toolResults(patrol).filter(r => r.text.startsWith('started subagent ')).length, 3)
assert.deepEqual(notices.map(n => n[2]), SERVICES.map(s => `${s}: ${RELEASES[s]?.[0]}`))
assert.equal(peak, 3)
assert.equal(patrolTurns, 4)
assert.equal(liveChildren(), 0)
assert.deepEqual(patrolChildren.map(e => [e.mode, e.activity]), SERVICES.map(() => ['continuable', 'inactive']))
assert.deepEqual(model.parents.get('patrol'), [])
const guided = model.childFirst.get(patrolChildren[0]!.id)?.taskBlocks ?? []
log(`子 agent 收到的任务消息 ${guided.length} 段；第 2 段开头：${named(guided[1] ?? '').slice(0, 72)}…`)
assert.equal(guided.length, 2)
assert.match(guided[1] ?? '', /^Your parent agent id is "patrol"\. Before you finish, send your result to that agent with send_message/)

log('')
log('== 2. 父 agent 还在跑时，结束通知并进当前这一轮 ==')
const busy = await open('busy', [
  [() => calls(['subagent', { description: 'check order-api', prompt: '查 order-api' }]), () => calls(['pause_ms', { ms: 600 }])],
  [() => reply('结果收到了。')],
])
busy.followup(human('查 order-api，顺便等一会儿'))
await settle(() => settledNotices(busy) === 1)
const busyLog = events(busy).flatMap(e => e.type === 'turn/start' || e.type === 'turn/end' ? [e.type]
  : e.type === 'tool/result' ? ['tool/result']
  : e.type === 'user/message' ? [`user/message(${e.data.source.kind})`] : [])
log(`父 agent 日志：${busyLog.join(' -> ')}`)
log(`父 agent 共 ${busyLog.filter(e => e === 'turn/end').length} 轮，模型请求 ${model.parentRequests.get('busy')} 次`)
assert.deepEqual(busyLog, ['turn/start', 'user/message(user)', 'tool/result', 'tool/result', 'user/message(subagent-settled)', 'turn/end'])
assert.equal(model.parentRequests.get('busy'), 3)

log('')
log('== 3. 回收顺序，以及用 send_message 叫回已回收的子 agent ==')
const sessionFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? sessionFiles(path) : [path]
})
const onDisk = (id: string) => sessionFiles(join(root, 'sessions')).filter(p => p.includes(id)).map(p => readFileSync(p, 'utf8')).join('')
const order: string[] = []
let relayChild = ''
ctx.on('agent/disposed', ({ agent }) => {
  if (agent.session.header.parentSession !== 'relay' || order.length > 0) return
  const lastSeq = agent.session.seq - 1
  order.push(`释放子 agent（此时盘上已有它的最后一条事件 seq ${lastSeq}：${onDisk(agent.id).includes(`"seq":${lastSeq},`)}）`)
})
ctx.on('agent/inbox/inserted', ({ agent, message }) => {
  if (agent.id !== 'relay' || message.source.kind !== 'subagent-settled' || order.length !== 1) return
  order.push(`父 agent 收到通知（此时子 agent 还在注册表：${ctx.agents.get(SessionId(relayChild)) !== undefined}）`)
})
const relay = await open('relay', [
  [() => calls(['subagent', { description: 'check order-api', prompt: '查 order-api' }]), () => reply('已派出。')],
  [() => calls(['send_message', { agent_id: relayChild, message: '再查一次' }]), () => reply('已经让它再查一次。')],
  [() => reply('第二份结果也收到了。')],
])
relay.followup(human('查 order-api'))
while (relayChild === '') {
  relayChild = /^started subagent (\S+)/.exec(toolResults(relay)[0]?.text ?? '')?.[1] ?? ''
  await new Promise(resolve => setTimeout(resolve, 1))
}
await settle(() => settledNotices(relay) === 2)
for (const line of order) log(line)
const relayResults = toolResults(relay)
log(`send_message -> ${named(relayResults[1]?.text ?? '')}`)
const second = model.childRequests.get(relayChild)?.[2] ?? []
log(`子 agent 被叫回后的第一次请求（去掉系统消息）：`)
for (const m of second.slice(1)) log(`  ${m.length > 40 ? `${m.slice(0, 40)}…` : m}`)
const relayNotices = events(relay).flatMap(e => e.type === 'user/message' && e.data.source.kind === 'subagent-settled'
  ? [e.data.content.map(b => b.type === 'text' ? b.text : '')[2]] : [])
log(`父 agent 收到 ${relayNotices.length} 条结束通知，结尾文本：${relayNotices.join(' / ')}`)
assert.equal(order.length, 2)
assert.match(order[0]!, /：true）$/)
assert.match(order[1]!, /：false）$/)
assert.equal(relayResults[1]?.text, `message delivered to agent ${relayChild}`)
assert.deepEqual(relayNotices, ['order-api: demo-007 succeeded', 'order-api: demo-007 succeeded'])
assert.ok(second.includes('user: order-api: demo-007 succeeded'))
assert.equal(second.at(-1), 'user: Agent relay sent a message: 再查一次')

log('')
log('== 4. run_in_background: false：同一步拿齐 3 份结果，子 agent 随即回收 ==')
peak = 0
const sweep = await open('sweep', [[
  () => calls(...SERVICES.map((s): [string, object] => ['subagent', { description: `check ${s}`, prompt: `查 ${s}`, run_in_background: false }])),
  () => reply('汇总：3 个服务里 payment-api 失败，已回滚。'),
]])
sweep.followup(human('查完 3 个服务再汇总'))
await settle()
for (const r of toolResults(sweep)) log(`subagent -> ${r.text}`)
log(`查询最多同时 ${peak} 个；父 agent 这一轮发了 ${model.parentRequests.get('sweep')} 次请求；还活着的子 agent ${liveChildren()} 个`)
const listed = await childrenOf('sweep')
for (const entry of listed) {
  const header = headers.get(entry.id)
  log(`  子会话 ${entry.label} mode=${entry.mode} activity=${entry.activity} parent=${header?.parentSession} depth=${header?.delegationDepth} origin=${header?.origin}`)
}
assert.equal(peak, 3)
assert.equal(model.parentRequests.get('sweep'), 2)
for (const entry of listed) {
  const header = headers.get(entry.id)
  assert.deepEqual([header?.parentSession, header?.delegationDepth, header?.origin], ['sweep', 1, 'subagent'])
}
assert.equal(liveChildren(), 0)
assert.deepEqual(listed.map(e => [e.label, e.mode, e.activity]),
  SERVICES.map(s => [`check ${s}`, 'one-shot', 'inactive']))
const oneShotBlocks = listed.map(e => model.childFirst.get(e.id)?.taskBlocks.length)
log(`前台子 agent 收到的任务消息各 ${oneShotBlocks.join('、')} 段，没有 send_message 说明`)
assert.deepEqual(oneShotBlocks, [1, 1, 1])

log('')
log('== 5. fork 看得到之前的轮次，看不到当前这一轮 ==')
const brief = await open('brief', [
  [() => reply('记下了：v2.3，3 个服务。')],
  [
    () => calls(['subagent_fork', { description: 'fork check', prompt: '查 payment-api' }],
      ['subagent', { description: 'spawn check', prompt: '查 payment-api', run_in_background: false }]),
    () => reply('两份结果都拿到了。'),
  ],
])
brief.followup(human('本次发布版本 v2.3，涉及 3 个服务'))
await settle()
brief.followup(human('payment-api 刚回滚过，重点看它'))
await settle()
const briefChildren = await childrenOf('brief')
for (const entry of briefChildren) {
  const first = model.childFirst.get(entry.id)
  assert.ok(first)
  log(`${entry.label} 的第一次请求：`)
  for (const m of first.messages.slice(1)) log(`  ${m.length > 40 ? `${m.slice(0, 40)}…` : m}`)
}
const [forkFirst, spawnFirst] = briefChildren.map(e => model.childFirst.get(e.id)?.messages.join('\n') ?? '')
assert.match(forkFirst ?? '', /v2\.3/)
assert.doesNotMatch(forkFirst ?? '', /重点看它/)
assert.doesNotMatch(spawnFirst ?? '', /v2\.3|重点看它/)

log('')
log('== 6. 子 agent 能用哪些工具 ==')
const setupMasked = await open('setup-masked', [[
  () => calls(['subagent', { description: 'rollback', prompt: '回滚 payment-api', run_in_background: false }],
    ['subagent_safe', { description: 'rollback safe', prompt: '回滚 order-api' }],
    ['subagent', { description: 'nested', prompt: '再派 user-api', run_in_background: false }]),
  () => reply('完成。'),
]], 'general', { deny: ['rollback_release'] })
const presetMasked = await open('preset-masked', [[
  () => calls(['subagent', { description: 'rollback', prompt: '回滚 user-api', run_in_background: false }]),
  () => reply('完成。'),
]], 'patrol')
const sees = (tools: string[] | undefined) => tools?.includes('rollback_release') === true ? '看得到' : '看不到'
for (const agent of [setupMasked, presetMasked]) {
  agent.followup(human('开始'))
  await settle()
}
const firstOf = (task: string) => [...model.childFirst.values()].find(c => c.task === task)
const schemaNames = (agent: Agent) => ctx.tools.schemas(agent).map(s => s.name)
// 子 agent 调用列表里没有的工具，是脚本故意的：证明执行也被拦住，不只是不展示。
log(`父 agent（setup 里 deny）：rollback_release ${sees(schemaNames(setupMasked))}`)
log(`  用 subagent 派的子 agent：${sees(firstOf('回滚 payment-api')?.tools)}，收到 -> ${toolResults(setupMasked)[0]?.text}`)
log(`  用 subagent_safe 派的子 agent：${sees(firstOf('回滚 order-api')?.tools)}，收到 -> ${toolResults(setupMasked)[1]?.text}`)
log(`父 agent（preset 里 deny）：rollback_release ${sees(schemaNames(presetMasked))}`)
log(`  用 subagent 派的子 agent：${sees(firstOf('回滚 user-api')?.tools)}，收到 -> ${toolResults(presetMasked)[0]?.text}`)
const statement = firstOf('回滚 payment-api')?.runtime.split('\n\n')[1] ?? ''
log(`子 agent 的运行时说明：${statement.slice(0, 64)}…`)
log(`子 agent 工具表里有 subagent：${firstOf('再派 user-api')?.tools.includes('subagent')}，再派一层 -> ${toolResults(setupMasked)[2]?.text}`)
assert.match(statement, /^You are a delegated subagent: your permission scope was fixed/)
assert.deepEqual(rollbacks, ['payment-api'])
assert.equal(sees(schemaNames(setupMasked)), '看不到')
assert.equal(sees(schemaNames(presetMasked)), '看不到')
assert.equal(firstOf('再派 user-api')?.tools.includes('subagent'), true)
assert.equal(sees(firstOf('回滚 payment-api')?.tools), '看得到')
assert.equal(sees(firstOf('回滚 order-api')?.tools), '看不到')
assert.equal(sees(firstOf('回滚 user-api')?.tools), '看不到')
assert.match(toolResults(setupMasked)[2]?.text ?? '', /subagent depth 2 exceeds maxDepth 1/)
assert.equal(toolResults(setupMasked)[1]?.text, 'Error: unknown tool "rollback_release"')
assert.equal(toolResults(presetMasked)[0]?.text, 'Error: unknown tool "rollback_release"')
const joinMasked = await open('join-masked', [[
  () => calls(['subagent', { description: 'rollback', prompt: '回滚 search-api', run_in_background: false }]),
  () => reply('完成。'),
]], 'joined')
joinMasked.followup(human('开始'))
await settle()
log(`父 agent（preset 行在 agent/created 里 allow）：工具 ${schemaNames(joinMasked).sort().join(', ')}`)
log(`  用 subagent 派的子 agent：工具 ${firstOf('回滚 search-api')?.tools.sort().join(', ')}，收到 -> ${toolResults(joinMasked)[0]?.text}`)
assert.deepEqual(schemaNames(joinMasked).sort(), ['lookup_release', 'subagent'])
assert.deepEqual(firstOf('回滚 search-api')?.tools.sort(), ['lookup_release', 'subagent'])
assert.equal(toolResults(joinMasked)[0]?.text, 'Error: unknown tool "rollback_release"')
// 挂上审批和沙箱策略服务：父会话显式覆盖沙箱，审批策略保持 ask。
await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: root })
await ctx.plugin(ApprovalService, { policy: 'ask' })
const guarded = await open('guarded', [[
  () => calls(['risky_op', { service: 'order-api' }], ['subagent', { description: 'approve', prompt: '审批 payment-api', run_in_background: false }]),
  () => reply('完成。'),
]])
guarded.session.append('sandbox/mode', { mode: 'workspace-write' })
guarded.followup(human('开始'))
await settle()
const [parentAsk, childAsk] = [approvals.find(a => a.agent === 'guarded'), approvals.find(a => a.agent !== 'guarded')]
log(`父 agent：沙箱覆盖 ${ctx.sandboxPolicy.overrideOf(guarded.session)}，审批策略 ask；调 risky_op -> ${parentAsk?.outcome}`)
log(`  子会话日志里的策略事件：${childAsk?.policy.join('；')}`)
log(`  子 agent 调 risky_op -> ${childAsk?.outcome}`)
assert.equal(parentAsk?.outcome, 'unavailable')
assert.deepEqual(childAsk?.policy, ['sandbox/mode workspace-write source=delegation', 'approval/policy never source=delegation'])
assert.equal(childAsk?.outcome, 'rejected')

log('')
log('== 7. 一次派 10 个：第 9、10 个被拒 ==')
let release: () => void = () => {}
gate = new Promise<void>(resolve => { release = resolve })
const many = Array.from({ length: 10 }, (_, i) => `svc-${String(i + 1).padStart(2, '0')}`)
const wide = await open('wide', [
  [
    () => calls(...many.map((s): [string, object] => ['subagent', { description: `check ${s}`, prompt: `查 ${s}` }])),
    () => reply('派出去 8 个。'),
  ],
  [
    () => calls(['subagent', { description: 'check order-api', prompt: '查 order-api', run_in_background: false }]),
    () => reply('前台查完了。'),
  ],
  ...many.map(() => [() => reply('收到。')]),
])
wide.followup(human('查 10 个服务'))
const started = Date.now() + 10_000
while (toolResults(wide).length < 10) {
  assert.ok(Date.now() < started, 'wide fan-out did not return')
  await new Promise(resolve => setTimeout(resolve, 5))
}
const wideResults = toolResults(wide)
log(`成功 ${wideResults.filter(r => !r.isError).length} 个，失败 ${wideResults.filter(r => r.isError).length} 个；此时还活着的子 agent ${liveChildren()} 个`)
log(`第 9 个 -> ${wideResults[8]?.text.split(';')[0]}`)
assert.deepEqual(wideResults.map(r => r.isError), Array.from({ length: 10 }, (_, i) => i >= 8))
assert.equal(liveChildren(), 8)
wide.followup(human('池满了，前台再查一个 order-api'))
while (toolResults(wide).length < 11) {
  assert.ok(Date.now() < started, 'foreground one-shot did not return')
  await new Promise(resolve => setTimeout(resolve, 5))
}
log(`池满时，前台一次性子 agent -> ${toolResults(wide)[10]?.text}；还活着的可继续子 agent ${liveChildren()} 个`)
assert.equal(toolResults(wide)[10]?.text, 'order-api: demo-007 succeeded')
release()
gate = undefined
await settle(() => settledNotices(wide) === 8)
log(`放行后：还活着的子 agent ${liveChildren()} 个，wide 收到 ${settledNotices(wide)} 条结束通知`)
assert.equal(liveChildren(), 0)
// subagent_deep 允许两层：一个可继续子 agent 再派 8 个可继续孙 agent。
gate = new Promise<void>(resolve => { release = resolve })
const deep = await open('deep', [
  [() => calls(['subagent_deep', { description: 'fan out', prompt: '分派 8' }]), () => reply('已派出。')],
  [() => reply('收到。')],
])
deep.followup(human('让子 agent 再分派 8 个'))
const deepDeadline = Date.now() + 10_000
while (fanout.length === 0) {
  assert.ok(Date.now() < deepDeadline, 'nested fan-out did not return')
  await new Promise(resolve => setTimeout(resolve, 5))
}
log(`子 agent 再派 8 个孙 agent：成功 ${fanout.filter(r => !r.isError).length} 个，失败 ${fanout.filter(r => r.isError).length} 个；此时还活着的子孙 ${liveChildren()} 个`)
log(`  失败的那个 -> ${fanout.find(r => r.isError)?.text.split(';')[0]}`)
assert.deepEqual(fanout.map(r => r.isError), Array.from({ length: 8 }, (_, i) => i === 7))
assert.equal(liveChildren(), 8)
release()
gate = undefined
await settle(() => settledNotices(deep) === 1)
assert.equal(liveChildren(), 0)
