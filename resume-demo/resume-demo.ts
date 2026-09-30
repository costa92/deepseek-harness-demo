/** Kill dsh in the middle of a release lookup, resume the session in a new process, then fork it. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as checkpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry, { type ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap { releaseQueries: string[] }
}

const log = (msg: string) => { console.log(msg) }
const sid = SessionId('oncall-demo')
const [, , role] = process.argv

/** A model that replays a fixed script and keeps every request it received. */
/** Script entry that streams a few words, then never finishes (the child is killed mid-attempt). */
const STALL: StreamChunk[] = []
class ScriptedModel extends LlmAdapter {
  readonly requests: Message[][] = []
  onStall: () => void = () => {}
  constructor(private readonly script: StreamChunk[][], private readonly latencyMs = 0) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options.messages)
    await new Promise(r => setTimeout(r, this.latencyMs))
    const entry = this.script.shift()
    assert.ok(entry, 'the scripted model ran out of replies')
    if (entry === STALL) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '正在核对 demo-003 的回滚记录，' }
      this.onStall()
      await new Promise(() => {})
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

const records = [
  { id: 'demo-003', service: 'payment-api', status: 'failed' },
  { id: 'demo-007', service: 'order-api', status: 'succeeded' },
]
const releaseOutput = {
  schema: { type: 'object', additionalProperties: false, properties: { ids: { type: 'array', items: { type: 'string' }, required: true } } },
  render: (_args: unknown, value: { ids: string[] }) => [{ type: 'text' as const, text: `${value.ids.length} record(s): ${value.ids.join(',')}` }],
} as const

/** Host-side fold: which services has this session looked up, in order. */
const releaseQueries: ProjectionDefinition<'releaseQueries'> = {
  key: 'releaseQueries',
  stateVersion: 1,
  stateSchema: { parse: (value: unknown) => value } as unknown as ProjectionDefinition<'releaseQueries'>['stateSchema'],
  init: () => [],
  apply: (state, event) => event.type === 'tool/call' && event.data.name === 'lookup_release'
    ? [...state, (JSON.parse(event.data.arguments) as { service: string }).service]
    : state,
}

/** How the child process misbehaves; the parent process never sets it. */
type Crash = 'hang' | 'die'
/** A pre-execute gate on open_incident that never lets the call reach its body. */
type Gate = 'hang' | 'ask'

interface BootOptions { crash?: Crash; latencyMs?: number; checkpoint?: boolean; gate?: Gate; compression?: 'none' | 'zstd' }
const boot = async (root: string, script: StreamChunk[][], opts: BootOptions = {}) => {
  const { crash, latencyMs, checkpoint = true, gate, compression = 'none' } = opts
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  // 默认 bundle 挂了它：模型请求前、顶层工具正文前各 flush 一次。
  if (checkpoint) await ctx.plugin(checkpointPolicy)
  const model = new ScriptedModel(script, latencyMs)
  model.onStall = () => { appendFileSync(join(root, 'stalled'), 'x') }
  ctx.llm.registerAdapter(['mock'], model)
  if (gate === 'hang') {
    // 卡住的守卫：tool/call 已追加，调用停在 prepare 阶段，工具正文不会运行。
    ctx.on('tools/pre-execute', (exec, next) => exec.name === 'open_incident' ? new Promise(() => {}) : next())
  }
  if (gate === 'ask') {
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    // 应答器永不返回：模拟值班负责人一直没点确认。
    ctx.on('approval/request', () => new Promise(() => {}))
    ctx.on('tools/pre-execute', (exec, next) => exec.name === 'open_incident'
      ? Promise.resolve({ kind: 'ask', reason: '开事故单要值班负责人确认' } as const)
      : next())
  }
  let lookups = 0
  ctx.tools.register(defineTool({
    name: 'lookup_release',
    description: 'Query synthetic release history for one service.',
    timeoutMs: 60_000,
    parameters: { service: { type: 'string', required: true } },
    output: releaseOutput,
    async execute(args) {
      // 子进程第二次查询时卡住，等父进程来杀。
      if (crash === 'hang' && ++lookups === 2) await new Promise(() => {})
      return { ids: records.filter(r => r.service === args.service).map(r => `${r.id} ${r.status}`) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'open_incident',
    description: 'Open an incident for a failed release (side effect: appends to incidents.log).',
    parameters: { release: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ticket: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.ticket }],
    },
    async execute(args) {
      appendFileSync(join(root, 'incidents.log'), `${args.release}\n`)
      // 副作用已经发生，进程在同一刻被杀：模拟 OOM、断电这类不给收尾机会的崩溃。
      if (crash === 'die') process.kill(process.pid, 'SIGKILL')
      return { ticket: `INC-${args.release}` }
    },
  }))
  ctx.sessionProjections.register(releaseQueries)
  await ctx.plugin(AgentLoop, { agents: [] })
  return { ctx, model }
}
const agentOptions = { provider: 'mock', model: 'mock' }
const ask = async (ctx: Context, agent: Agent, text: string) => {
  const idle = new Promise<void>((resolve) => {
    const off = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { off(); resolve() }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
  await ctx.sessions.flush(agent.session)
}

if (role === 'child') {
  // 子进程：argv = child <root> <sessionId> <scenario>
  const [, , , dir, id, scenario] = process.argv
  assert.ok(dir && id && scenario)
  const secondTurn = scenario === 'hang'
    ? [callTool('call-2', 'lookup_release', { service: 'order-api' })]
    : scenario === 'stall' ? [STALL] : [callTool('call-2', 'open_incident', { release: 'demo-003' })]
  // 真实模型每次请求都要几百毫秒，这里给脚本模型 300ms 延迟；fast 场景只给 50ms。
  const { ctx } = await boot(dir, [
    callTool('call-1', 'lookup_release', { service: 'payment-api' }),
    reply('payment-api 最近一次发布 demo-003 失败。'),
    ...secondTurn,
  ], {
    crash: scenario === 'hang' ? 'hang' : 'die',
    latencyMs: scenario === 'no-policy-fast' ? 50 : 300,
    checkpoint: !scenario.startsWith('no-policy'),
    ...scenario === 'guard-hang' ? { gate: 'hang' as const } : scenario === 'approval-hang' ? { gate: 'ask' as const } : {},
  })
  const { agent } = await ctx.agents.create({ sessionId: SessionId(id), agentOptions })
  setInterval(() => {}, 1000)
  await ask(ctx, agent, 'payment-api 最近一次发布怎么样？')
  agent.followup(createUserMessage({ content: [{ type: 'text', text: scenario === 'hang' ? '顺便看下 order-api' : scenario === 'stall' ? 'demo-003 回滚了吗' : '给 demo-003 开个事故单' }], source: { kind: 'user' } }))
  await new Promise(() => {})
}

const root = mkdtempSync(join(tmpdir(), 'dsh-resume-demo-'))
process.once('exit', () => { rmSync(root, { recursive: true, force: true }) })
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)])
const logFile = (id: string) => {
  const file = files(root).find(f => f.endsWith(join('/', id, 'session.v3.jsonl')))
  assert.ok(file, `no log for ${id}`)
  return file
}
const readLog = (id: string) => {
  const [header, ...lines] = readFileSync(logFile(id), 'utf8').split('\n')
  const complete = lines.filter(Boolean).filter(l => { try { JSON.parse(l); return true } catch { return false } })
  return { header: JSON.parse(header ?? '{}') as Record<string, unknown>, events: complete.map(l => JSON.parse(l) as SessionEvent) }
}
const textOf = (content: unknown) => (content as { type: string; text?: string }[]).map(b => b.text ?? `<${b.type}>`).join('')
const brief = (e: SessionEvent): string => {
  switch (e.type) {
    case 'user/message': return textOf(e.data.content)
    case 'assistant/message': return e.data.message.content.map(b => b.type === 'tool-call' ? `call ${b.name}(${b.arguments})` : b.type === 'text' ? b.text : `<${b.type}>`).join(' ')
    case 'tool/call': return `${e.data.name} ${e.data.arguments}`
    case 'tool/result': return `${e.data.error ? `[${e.data.error.code}] ` : ''}${textOf((e.data.message.content[0] as { content: unknown }).content)}`
    case 'turn/end': return e.data.reason.kind
    case 'session/end-seed': return JSON.stringify(e.data)
    default: return ''
  }
}
const show = (events: readonly SessionEvent[], width = 90) => {
  for (const e of events) {
    const b = brief(e)
    log(`  ${String(e.seq).padStart(2)} ${e.type.padEnd(18)} ${b.length > width ? `${b.slice(0, width)}…` : b}`)
  }
}

const spawnChild = (id: string, scenario: string) => {
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), 'child', root, id, scenario], { stdio: 'inherit' })
  const exited = new Promise<NodeJS.Signals | null>((resolve) => { child.once('exit', (_code, signal) => { resolve(signal) }) })
  // 父进程断言失败提前退出时，别留下卡住的子进程。
  process.prependOnceListener('exit', () => { child.kill('SIGKILL') })
  return { child, exited }
}
const turnOf = (events: readonly SessionEvent[]) => events.slice(events.findLastIndex(e => e.type === 'turn/start'))

log('1. kill -9 while the second lookup_release is running')
const { child, exited } = spawnChild(sid, 'hang')
const onDisk = () => files(root).some(f => f.endsWith('.jsonl')) && readLog(sid).events.some(e => e.type === 'tool/call' && e.data.callId === 'call-2')
for (let i = 0; i < 1000 && !onDisk(); i++) await new Promise(r => setTimeout(r, 20))
assert.ok(onDisk(), 'the child never recorded the second call')
let { ctx, model } = await boot(root, [])
// 子进程还活着：它持有会话目录上的内核写锁，另一个进程接不过来。
await assert.rejects(ctx.agents.resume({ resumeSessionId: sid, agentOptions }), (e: Error) => {
  log(`  resume while the old process is alive -> ${e.name}`)
  return e.name === 'SessionAlreadyOwnedError'
})
child.kill('SIGKILL')
log(`  child exited by ${String(await exited)}; the log ends inside turn 1:`)
const crashed = readLog(sid).events
const crashedText = readFileSync(logFile(sid), 'utf8')
show(turnOf(crashed))
assert.equal(crashed.at(-1)?.type, 'tool/call', 'the call was recorded, its result never was')

log('2. a torn last line (simulated: bytes a crash could leave mid-write)')
const torn = `{"type":"tool/result","seq":${String(crashed.length)},"ti`
appendFileSync(logFile(sid), torn)
log(`  appended ${torn.length} bytes without a newline`)
{
  // 另一个只读的查询进程：session-query 冷读崩溃日志，不拿写锁、不写回。
  const reader = new Context()
  await reader.plugin(SessionStore)
  await reader.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await reader.plugin(SqliteSessionQueryEngine, { path: join(root, 'session-search.db') })
  const bytesBefore = readFileSync(logFile(sid))
  const cold = await reader.sessionQuery.readSession(sid)
  const tail = cold.events.slice(crashed.length)
  log(`  session-query readSession (cold): ${cold.events.length} events, synthetic tail: ${tail.map(e => e.type === 'tool/result' && e.data.error ? `tool/result[${e.data.error.code}]` : e.type).join(', ')}`)
  log(`  log bytes unchanged by the read: ${readFileSync(logFile(sid)).equals(bytesBefore)}`)
  assert.deepEqual(tail.map(e => e.type), ['tool/result', 'step/end', 'turn/end'])
  assert.ok(readFileSync(logFile(sid)).equals(bytesBefore))
  await reader.fiber.dispose()
  rmSync(join(root, 'session-search.db'), { force: true })
}

log('3. resume in a new process: the open turn gets synthetic closers')
await ctx.fiber.dispose()
;({ ctx, model } = await boot(root, [
  callTool('call-3', 'lookup_release', { service: 'order-api' }),
  reply('重新查到了：order-api 最近一次发布 demo-007 成功。'),
]))
const handle = await ctx.agents.resume({ resumeSessionId: sid, agentOptions })
await ctx.sessions.flush(handle.agent.session)
const resumed = readLog(sid).events
show(resumed.slice(crashed.length))
const closers = resumed.slice(crashed.length, crashed.length + 3)
assert.deepEqual(closers.map(e => e.type), ['tool/result', 'step/end', 'turn/end'])
const body = readFileSync(logFile(sid), 'utf8')
assert.ok(body.endsWith('\n') && body.trim().split('\n').every(l => { try { JSON.parse(l); return true } catch { return false } }), 'the torn bytes are gone')
const [unknown] = closers
assert.ok(unknown?.type === 'tool/result')
assert.equal(unknown.data.error?.code, 'TOOL_OUTCOME_UNKNOWN')
assert.deepEqual(unknown.sourceEventSeqs, [crashed.at(-1)?.seq])
log('  torn bytes discarded before the first new append')

log('4. the next turn: the model reads the synthetic error and retries the read-only lookup')
await ask(ctx, handle.agent, '继续')
const request = model.requests[0] ?? []
const synthetic = request.find(m => m.role === 'user' && m.content.some(b => b.type === 'tool-result' && b.isError))
assert.ok(synthetic, 'the synthetic error result is in the model history')
log(`  model request after resume: ${request.length} messages, including the synthetic result:`)
for (const sentence of textOf((synthetic.content[0] as { content: unknown }).content).split(/(?<=[.;]) /)) log(`    | ${sentence}`)
show(turnOf(readLog(sid).events).filter(e => ['user/message', 'tool/call', 'tool/result', 'turn/end'].includes(e.type)))
const queries = ctx.sessionProjections.stateOf(handle.agent.session, 'releaseQueries')
log(`  releaseQueries = ${JSON.stringify(queries)}`)
assert.deepEqual(queries, ['payment-api', 'order-api', 'order-api'])

log('5. kill at the instant open_incident has acted, with and without the checkpoint policy')
for (const [id, scenario] of [['incident-a', 'no-policy'], ['incident-b', 'policy']] as const) {
  rmSync(join(root, 'incidents.log'), { force: true })
  const run = spawnChild(id, scenario)
  assert.equal(await run.exited, 'SIGKILL')
  const incidents = readFileSync(join(root, 'incidents.log'), 'utf8').trim().split('\n').length
  const h = await ctx.agents.resume({ resumeSessionId: SessionId(id), agentOptions })
  await ctx.sessions.flush(h.agent.session)
  const last = turnOf(readLog(id).events).filter(e => ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end'].includes(e.type))
  const chain = last.map(e => e.type === 'tool/result' && e.data.error ? `tool/result[${e.data.error.code}]` : e.type === 'turn/end' ? `turn/end(${e.data.reason.kind})` : e.type)
  log(`  ${scenario}: incidents.log has ${incidents} line; last turn after resume:`)
  log(`    ${chain.join(' > ')}`)
  if (scenario === 'no-policy') assert.deepEqual(chain, ['user/message', 'turn/end(interrupted)'], 'the call left no trace in the log')
  else assert.deepEqual(chain, ['user/message', 'assistant/message', 'tool/call', 'tool/result[TOOL_OUTCOME_UNKNOWN]', 'turn/end(interrupted)'])
  assert.equal(incidents, 1)
}

log('6. fork: only at a turn boundary, into a new log that remembers its parent')
const inside = crashed.at(-1)?.seq
assert.ok(inside !== undefined)
assert.throws(() => ctx.sessions.fork(sid, SessionSeq(inside)), (e: Error & { code?: string }) => {
  log(`  sessions.fork at seq ${inside} (inside turn 1) -> ${e.code}`)
  return e.code === 'OPEN_TURN'
})
const parentBytes = readFileSync(logFile(sid))
const cutAt = resumed.findLast(e => e.type === 'turn/end')
assert.ok(cutAt)
const childId = SessionId('oncall-demo-fork')
const seed = resumed.slice(0, cutAt.seq + 1)
ctx.llm.registerAdapter(['mock-fork'], new ScriptedModel([reply('分支里只看 payment-api：先不重查 order-api。')]))
const fork = await ctx.agents.create({
  sessionId: childId,
  seed,
  inheritedEventCount: SessionLogOffset(seed.length),
  meta: { parentSession: sid, isSeeded: true },
  agentOptions: { provider: 'mock-fork', model: 'mock' },
})
await ask(ctx, fork.agent, '先别重查，只总结 payment-api')
const forked = readLog(childId)
log(`  seed = parent seq 0..${cutAt.seq} (ends at the interrupted turn/end); child header: parentSession=${String(forked.header.parentSession)} isSeeded=${String(forked.header.isSeeded)}`)
show(forked.events.slice(seed.length, seed.length + 2))
assert.equal(forked.header.parentSession, sid)
assert.deepEqual(forked.events.slice(0, seed.length), seed, 'the child log starts with a copy of the prefix')
assert.equal(forked.events.findLastIndex(e => e.type === 'session/end-seed' && e.data.inherited === true), seed.length, 'the cut is stored as a marker, not in the header')
assert.ok(readFileSync(logFile(sid)).equals(parentBytes), 'the parent log is untouched')
log(`  parent log unchanged; child releaseQueries = ${JSON.stringify(ctx.sessionProjections.stateOf(fork.agent.session, 'releaseQueries'))}`)
assert.deepEqual(ctx.sessionProjections.stateOf(fork.agent.session, 'releaseQueries'), ['payment-api', 'order-api'])

const chainOf = (events: readonly SessionEvent[]) => turnOf(events)
  .filter(e => ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'approval/asked', 'approval/decided', 'turn/end'].includes(e.type))
  .map(e => e.type === 'tool/result' && e.data.error ? `tool/result[${e.data.error.code}]` : e.type === 'turn/end' ? `turn/end(${e.data.reason.kind})` : e.type)

log('7. the log ends at the assistant message, before tool/call: TOOL_NOT_STARTED')
const nsid = SessionId('oncall-not-started')
{
  const [header, ...lines] = crashedText.trimEnd().split('\n')
  assert.equal((JSON.parse(lines.at(-1) ?? '{}') as SessionEvent).type, 'tool/call')
  const dir = join(dirname(dirname(logFile(sid))), nsid)
  mkdirSync(dir)
  writeFileSync(join(dir, 'session.v3.jsonl'), `${[JSON.stringify({ ...JSON.parse(header ?? '{}') as object, id: nsid }), ...lines.slice(0, -1)].join('\n')}\n`)
}
const ns = await ctx.agents.resume({ resumeSessionId: nsid, agentOptions })
await ctx.sessions.flush(ns.agent.session)
const nsEvents = readLog(nsid).events
show(nsEvents.slice(crashed.length - 2, crashed.length + 2))
const notStarted = nsEvents[crashed.length - 1]
assert.ok(notStarted?.type === 'tool/result')
assert.equal(notStarted.data.error?.code, 'TOOL_NOT_STARTED')

log('8. tool/call is logged before the guards run: a stuck guard, then kill -9')
{
  rmSync(join(root, 'incidents.log'), { force: true })
  const run = spawnChild('gated', 'guard-hang')
  const recorded = () => files(root).some(f => f.endsWith(join('/', 'gated', 'session.v3.jsonl'))) && readLog('gated').events.some(e => e.type === 'tool/call' && e.data.name === 'open_incident')
  for (let i = 0; i < 1000 && !recorded(); i++) await new Promise(r => setTimeout(r, 20))
  assert.ok(recorded(), 'the child never recorded open_incident')
  run.child.kill('SIGKILL')
  await run.exited
  const ran = existsSync(join(root, 'incidents.log'))
  const h = await ctx.agents.resume({ resumeSessionId: SessionId('gated'), agentOptions })
  await ctx.sessions.flush(h.agent.session)
  log(`  tool body ran: ${ran}; last turn after resume:`)
  log(`    ${chainOf(readLog('gated').events).join(' > ')}`)
  assert.equal(ran, false)
  assert.deepEqual(chainOf(readLog('gated').events), ['user/message', 'assistant/message', 'tool/call', 'tool/result[TOOL_OUTCOME_UNKNOWN]', 'turn/end(interrupted)'])
}

log('9. crash while waiting for approval: an answerer that never returns, then kill -9')
{
  const run = spawnChild('asking', 'approval-hang')
  const asked = () => files(root).some(f => f.endsWith(join('/', 'asking', 'session.v3.jsonl'))) && readLog('asking').events.some(e => e.type === 'approval/asked')
  for (let i = 0; i < 1000 && !asked(); i++) await new Promise(r => setTimeout(r, 20))
  assert.ok(asked(), 'the child never logged approval/asked')
  run.child.kill('SIGKILL')
  await run.exited
  const h = await ctx.agents.resume({ resumeSessionId: SessionId('asking'), agentOptions })
  await ctx.sessions.flush(h.agent.session)
  const chain = chainOf(readLog('asking').events)
  log(`  tool body ran: ${existsSync(join(root, 'incidents.log'))}; last turn after resume:`)
  log(`    ${chain.join(' > ')}`)
  assert.equal(existsSync(join(root, 'incidents.log')), false)
  assert.ok(!chain.includes('approval/decided'))
}

log('10. the 200ms write window: an append is only in memory until the batch timer fires')
{
  const w = await ctx.agents.create({ sessionId: SessionId('window'), agentOptions })
  const onDiskNow = () => files(root).some(f => f.endsWith(join('/', 'window', 'session.v3.jsonl'))) && readLog('window').events.some(e => e.type === 'sandbox/mode')
  w.agent.session.append('sandbox/mode' as never, { mode: 'read-only' } as never)
  const at0 = onDiskNow()
  await new Promise(r => setTimeout(r, 250))
  const at250 = onDiskNow()
  log(`  appended; on disk right away: ${at0}; 250ms later: ${at250}`)
  assert.equal(at0, false)
  assert.equal(at250, true)
}

log('11. without the policy and with a 50ms model, kill at the instant open_incident has acted')
{
  rmSync(join(root, 'incidents.log'), { force: true })
  const run = spawnChild('incident-fast', 'no-policy-fast')
  assert.equal(await run.exited, 'SIGKILL')
  const incidents = readFileSync(join(root, 'incidents.log'), 'utf8').trim().split('\n').length
  const h = await ctx.agents.resume({ resumeSessionId: SessionId('incident-fast'), agentOptions })
  await ctx.sessions.flush(h.agent.session)
  const events = readLog('incident-fast').events
  const asked = events.some(e => e.type === 'user/message' && brief(e) === '给 demo-003 开个事故单')
  const turns = events.filter(e => e.type === 'turn/start').length
  log(`  incidents.log has ${incidents} line; "给 demo-003 开个事故单" in the log: ${asked}; turns in the log: ${turns}`)
  log(`  log after resume ends: ${events.slice(-3).map(e => e.type).join(', ')}`)
  assert.equal(incidents, 1)
  assert.equal(asked, false)
  assert.equal(turns, 1, 'the second turn left nothing on disk')
}

log('12. kill -9 while the model is streaming: no checkpoint inside an active attempt')
{
  rmSync(join(root, 'stalled'), { force: true })
  const run = spawnChild('stalled', 'stall')
  for (let i = 0; i < 1000 && !existsSync(join(root, 'stalled')); i++) await new Promise(r => setTimeout(r, 20))
  assert.ok(existsSync(join(root, 'stalled')), 'the child never started streaming')
  // 超过 200ms 的批处理窗口，缓冲里有什么都该落盘了。
  await new Promise(r => setTimeout(r, 400))
  run.child.kill('SIGKILL')
  await run.exited
  const before = turnOf(readLog('stalled').events).map(e => e.type)
  const h = await ctx.agents.resume({ resumeSessionId: SessionId('stalled'), agentOptions })
  await ctx.sessions.flush(h.agent.session)
  const after = readLog('stalled').events
  const streamed = after.some(e => JSON.stringify(e).includes('正在核对'))
  log(`  on disk at the kill (turn 1): ${before.join(', ')}`)
  log(`  after resume: ${chainOf(after).join(' > ')}; streamed words in the log: ${streamed}`)
  assert.ok(!before.includes('assistant/message'))
  assert.equal(streamed, false)
}

log('13. zstd: a torn final frame is decoded, re-encoded and rewritten on resume')
{
  const zroot = mkdtempSync(join(tmpdir(), 'dsh-resume-demo-zstd-'))
  process.once('exit', () => { rmSync(zroot, { recursive: true, force: true }) })
  const zid = SessionId('zstd-demo')
  let z = await boot(zroot, [callTool('call-z1', 'lookup_release', { service: 'payment-api' }), reply('demo-003 失败。')], { compression: 'zstd' })
  let zh = await z.ctx.agents.create({ sessionId: zid, agentOptions })
  await ask(z.ctx, zh.agent, 'payment-api 最近一次发布怎么样？')
  await z.ctx.fiber.dispose()
  z = await boot(zroot, [callTool('call-z2', 'lookup_release', { service: 'order-api' }), reply('demo-007 成功。')], { compression: 'zstd' })
  zh = await z.ctx.agents.resume({ resumeSessionId: zid, agentOptions })
  await ask(z.ctx, zh.agent, 'order-api 呢？')
  const committed = zh.agent.session.snapshotEvents().length
  await z.ctx.fiber.dispose()
  const zfile = files(zroot).find(f => f.endsWith('session.v3.jsonl.zstd'))
  assert.ok(zfile)
  const bytes = readFileSync(zfile)
  let lastFrame = 0
  for (let i = 0; i + 4 <= bytes.length; i++) if (bytes.readUInt32LE(i) === 0xFD2FB528) lastFrame = i
  truncateSync(zfile, bytes.length - 4)
  const zstdTest = () => spawnSync('zstd', ['-t', zfile]).status
  log(`  ${committed} events; last frame's 4-byte checksum dropped; zstd -t exit ${zstdTest()}`)
  z = await boot(zroot, [], { compression: 'zstd' })
  zh = await z.ctx.agents.resume({ resumeSessionId: zid, agentOptions })
  await z.ctx.sessions.flush(zh.agent.session)
  const resumed = zh.agent.session.snapshotEvents()
  await z.ctx.fiber.dispose()
  const fixed = readFileSync(zfile)
  const prefixKept = fixed.subarray(0, lastFrame).equals(bytes.subarray(0, lastFrame))
  // 只截断的话，校验和回不来；和撕裂前逐字节相同，说明这一帧被解出后重新编码写回。
  const frameRestored = fixed.subarray(lastFrame, bytes.length).equals(bytes.subarray(lastFrame))
  log(`  after resume: ${resumed.length} events (last: ${resumed.at(-1)?.type}); zstd -t exit ${zstdTest()}`)
  log(`  bytes before the torn frame unchanged: ${prefixKept}; torn frame rewritten with its checksum back: ${frameRestored}`)
  assert.equal(resumed.length, committed + 1)
  assert.equal(zstdTest(), 0)
  assert.ok(prefixKept && frameRestored)
}

await ctx.fiber.dispose()
process.exit(0)
