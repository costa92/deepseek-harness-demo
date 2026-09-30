/** Run one release query through a real agent loop, then rebuild what happened from the session log alone. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq, foldSurface, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry, { type ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap { releaseQueries: string[] }
}

const log = (msg: string) => { console.log(msg) }
const root = mkdtempSync(join(tmpdir(), 'dsh-session-demo-'))
process.once('exit', () => { rmSync(root, { recursive: true, force: true }) })
const sid = SessionId('oncall-demo')

/** A model that replays a fixed script: one entry per request. */
class ScriptedModel extends LlmAdapter {
  constructor(private readonly script: StreamChunk[][]) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
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

const records = [
  { id: 'demo-003', service: 'payment-api', status: 'failed' },
  { id: 'demo-007', service: 'order-api', status: 'succeeded' },
]
const lookupRelease = defineTool({
  name: 'lookup_release',
  description: 'Query synthetic release history for one service.',
  timeoutMs: 5000,
  parameters: { service: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { ids: { type: 'array', items: { type: 'string' }, required: true } } },
    render: (_args, value) => [{ type: 'text', text: `${value.ids.length} record(s): ${value.ids.join(',')}` }],
  },
  async execute(args) {
    return { ids: records.filter(r => r.service === args.service).map(r => `${r.id} ${r.status}`) }
  },
})

/** Host-side fold: which services has this session looked up, in order. */
const releaseQueries: ProjectionDefinition<'releaseQueries'> = {
  key: 'releaseQueries',
  stateVersion: 1,
  // 只有挂了持久化投影缓存才会用它校验旧状态；本 demo 没挂，原样放行。
  stateSchema: { parse: (value: unknown) => value } as unknown as ProjectionDefinition<'releaseQueries'>['stateSchema'],
  init: () => [],
  apply: (state, event) => event.type === 'tool/call' && event.data.name === 'lookup_release'
    ? [...state, (JSON.parse(event.data.arguments) as { service: string }).service]
    : state,
}

interface BootOptions { id?: SessionId; dir?: string; compression?: 'none' | 'zstd'; sandboxPolicy?: boolean }
const boot = async (script: StreamChunk[][], opts: BootOptions = {}) => {
  const { id = sid, dir = root, compression = 'none' } = opts
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: dir, compression })
  if (opts.sandboxPolicy === true) await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: dir })
  ctx.llm.registerAdapter(['mock'], new ScriptedModel(script))
  ctx.tools.register(lookupRelease)
  ctx.sessionProjections.register(releaseQueries)
  await ctx.plugin(AgentLoop, { agents: [{ id: 'oncall', sessionId: id, provider: 'mock', model: 'mock' }] })
  for (let i = 0; i < 500 && !ctx.agents.get(id); i++) await new Promise(r => setTimeout(r, 10))
  const agent = ctx.agents.get(id)
  assert.ok(agent, 'the agent never came up')
  return { ctx, agent }
}
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
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)])
const logFile = () => {
  const file = files(root).find(f => f.endsWith('.jsonl'))
  assert.ok(file)
  return file
}
/** Parse the JSONL file directly: line 1 is the header, every other line is one event. */
const readLog = () => {
  const [header, ...lines] = readFileSync(logFile(), 'utf8').trim().split('\n')
  return { header: JSON.parse(header ?? '{}') as Record<string, unknown>, events: lines.map(l => JSON.parse(l) as SessionEvent) }
}
const textOf = (content: unknown) => (content as { type: string; text?: string }[]).map(b => b.text ?? `<${b.type}>`).join('')
const brief = (e: SessionEvent): string => {
  switch (e.type) {
    case 'user/message': return textOf(e.data.content)
    case 'assistant/message': return e.data.message.content.map(b => b.type === 'tool-call' ? `call ${b.name}(${b.arguments})` : b.type === 'text' ? b.text : `<${b.type}>`).join(' ')
    case 'tool/call': return `${e.data.name} ${e.data.arguments}`
    case 'tool/result': return textOf((e.data.message.content[0] as { content: unknown }).content)
    case 'turn/end': return e.data.reason.kind
    case 'request/header': return `${e.data.reason} tools=[${(e.data.header.tools ?? []).map(t => t.name).join(',')}]`
    default: return ''
  }
}

if (process.argv[2] === 'fsync-child') {
  // strace 下的子进程：问一轮、重启、再问一轮，只为留下系统调用序列。
  let host = await boot([callTool('call-1', 'lookup_release', { service: 'payment-api' }), reply('demo-003 失败。')])
  await ask(host.ctx, host.agent, 'payment-api 最近一次发布怎么样？')
  await host.ctx.fiber.dispose()
  host = await boot([reply('好的。')])
  await ask(host.ctx, host.agent, '谢谢')
  await host.ctx.fiber.dispose()
  process.exit(0)
}

log('1. one query through the real agent loop, persisted as JSONL')
let { ctx, agent } = await boot([
  callTool('call-1', 'lookup_release', { service: 'payment-api' }),
  reply('payment-api 最近一次发布 demo-003 失败。'),
])
await ask(ctx, agent, 'payment-api 最近一次发布怎么样？')
const first = readLog()
log(`  file: ${logFile().replace(root, '<root>')}`)
log(`  header: version=${String(first.header.version)} id=${String(first.header.id)}`)
for (const e of first.events) {
  const mark = 'surfaceOp' in e && e.surfaceOp !== undefined ? '*' : ' '
  log(`  ${mark}${String(e.seq).padStart(2)} ${e.type.padEnd(20)} ${brief(e).slice(0, 60)}`)
}
assert.deepEqual(first.events.map(e => e.type), [
  'agent/inbox/spliced', 'turn/start', 'agent/inbox/spliced', 'step/start', 'system/message', 'user/message',
  'request/header', 'request/context', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
  'step/start', 'assistant/message', 'step/end', 'turn/end',
])

log('2. the model history is derived, not stored')
const nodes = agent.session.surface.nodes
const messages = agent.session.deriveMessages()
log(`  ${first.events.length} events -> surface ${JSON.stringify(nodes)} -> ${messages.length} messages: ${messages.map(m => m.role).join(', ')}`)
assert.deepEqual(nodes, [4, 5, 8, 10, 13])
assert.deepEqual(messages.map(m => m.role), ['system', 'user', 'assistant', 'user', 'assistant'])
const offline = foldSurface(first.events, [])
log(`  foldSurface over the parsed file -> ${JSON.stringify(offline.nodes)}`)
assert.deepEqual(offline.nodes, nodes)

log('3. rebuild the query trajectory from the file alone')
const trajectory: string[] = []
for (const e of first.events) {
  if (['user/message', 'tool/call', 'tool/result', 'turn/end'].includes(e.type)) trajectory.push(`${e.type} ${brief(e)}`)
  if (e.type === 'user/message') log(`  user asked              ${JSON.stringify(brief(e))}`)
  if (e.type === 'request/header') log(`  request header seq ${e.seq}: ${brief(e)}`)
  if (e.type === 'tool/call') log(`  step ${e.data.step}: model called     ${brief(e)}`)
  if (e.type === 'tool/result') log(`  step ${e.data.step}: tool returned    ${JSON.stringify(brief(e))}`)
  if (e.type === 'assistant/message' && e.data.message.content.some(b => b.type === 'text')) log(`  step ${e.data.step}: model answered   ${JSON.stringify(brief(e))}`)
  if (e.type === 'turn/end') log(`  turn ${e.data.turn}: ended          ${brief(e)}`)
}
assert.deepEqual(trajectory, [
  'user/message payment-api 最近一次发布怎么样？',
  'tool/call lookup_release {"service":"payment-api"}',
  'tool/result 1 record(s): demo-003 failed',
  'turn/end completed',
])

log('4. append-only: restart and ask again, the file only grows')
const before = readFileSync(logFile())
await ctx.fiber.dispose()
;({ ctx, agent } = await boot([
  callTool('call-2', 'lookup_release', { service: 'order-api' }),
  reply('order-api 最近一次发布 demo-007 成功。'),
]))
const restoredMessages = agent.session.deriveMessages()
await ask(ctx, agent, 'order-api 呢？')
const after = readFileSync(logFile())
const second = readLog()
log(`  bytes ${before.length} -> ${after.length}, old bytes are a prefix: ${after.subarray(0, before.length).equals(before)}`)
log(`  events ${first.events.length} -> ${second.events.length}, seq contiguous: ${second.events.every((e, i) => e.seq === i)}`)
log(`  request/header snapshots: ${second.events.filter(e => e.type === 'request/header').map(e => `seq ${e.seq} ${brief(e)}`).join('; ')}`)
log(`  first new event: seq ${first.events.length} ${second.events[first.events.length]?.type}`)
assert.ok(after.subarray(0, before.length).equals(before))
assert.ok(second.events.every((e, i) => e.seq === i))
assert.equal(second.events[first.events.length]?.type, 'session/end-seed')

log('5. restart = replay: history and projections come back from the log')
log(`  restored history equals the pre-restart history: ${JSON.stringify(restoredMessages) === JSON.stringify(messages)}`)
assert.equal(JSON.stringify(restoredMessages), JSON.stringify(messages))
const queried = ctx.sessionProjections.stateOf(agent.session, 'releaseQueries')
log(`  releaseQueries projection after restart + turn 2: ${JSON.stringify(queried)}`)
assert.deepEqual(queried, ['payment-api', 'order-api'])
await ctx.fiber.dispose()

log('6. a reader refuses events it does not understand, unless marked ignorable')
const original = readFileSync(logFile(), 'utf8')
for (const ignorable of [false, true]) {
  const copy = mkdtempSync(join(tmpdir(), 'dsh-session-demo-copy-'))
  process.once('exit', () => { rmSync(copy, { recursive: true, force: true }) })
  cpSync(root, copy, { recursive: true })
  const last = second.events.at(-1)
  assert.ok(last)
  const extra = { type: 'release/audit', seq: last.seq + 1, time: last.time + 1, data: { note: 'written by a newer plugin' }, ...ignorable ? { ignorable: true } : {} }
  writeFileSync(logFile().replace(root, copy), `${original}${JSON.stringify(extra)}\n`)
  const reader = new Context()
  await reader.plugin(SessionStore)
  await reader.plugin(JsonlSessionPersistence, { root: copy, compression: 'none' })
  try {
    const handle = await reader.sessionPersistence.open(sid, 'read')
    const { events } = await handle.read()
    await handle.close()
    log(`  ignorable=${ignorable}: read ${events.length} events, last=${events.at(-1)?.type}`)
    assert.ok(ignorable)
  } catch (error) {
    log(`  ignorable=${ignorable}: ${(error as Error).message.split(' — ')[0]}`)
    assert.ok(!ignorable)
  }
  await reader.fiber.dispose()
}

// 以下步骤各用一个新会话，文件路径写死，不再用只取第一个 .jsonl 的 logFile()。
const sessionFile = (dir: string, id: string, ext = 'jsonl') => join(dir, '_no-cwd', id, `session.v3.${ext}`)
const parse = (file: string) => readFileSync(file, 'utf8').trim().split('\n').slice(1).map(l => JSON.parse(l) as SessionEvent)

log('7. request/header: appended at start, on change, and on a new series only')
const hid = SessionId('header-demo')
;({ ctx, agent } = await boot([reply('第一轮。'), reply('第二轮。'), reply('第三轮。'), reply('第四轮。')], { id: hid, sandboxPolicy: true }))
await ask(ctx, agent, '第一轮')
await ask(ctx, agent, '第二轮，工具没变')
ctx.tools.register(defineTool({
  name: 'rollback_release',
  description: 'Roll a service back to its previous release.',
  parameters: { service: { type: 'string', required: true } },
  output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'ok' }] },
  async execute() { return { ok: true } },
}))
await ask(ctx, agent, '第三轮，两轮之间注册了 rollback_release')
// 用一个新节点遮住前三轮的全部消息（压缩就是这样替换 surface 的），再问一轮。
const shadowed = agent.session.surface.nodes.slice(1)
agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '（前三轮的摘要）' }], source: { kind: 'user' } }), {
  surfaceOp: { op: 'replace', startSeq: SessionSeq(shadowed[0] ?? 0), endSeq: SessionSeq(shadowed.at(-1) ?? 0) },
  sourceEventSeqs: shadowed.map(n => SessionSeq(n)),
})
await ask(ctx, agent, '第四轮，surface 刚被替换')
const headerEvents = parse(sessionFile(root, hid)).filter(e => e.type === 'request/header' || e.type === 'turn/start')
let turnNo = 0
const headerLines: string[] = []
for (const e of headerEvents) {
  if (e.type === 'turn/start') turnNo++
  else headerLines.push(`turn ${turnNo}: seq ${e.seq} ${brief(e)}${e.type === 'request/header' && e.data.startsSeries ? ' startsSeries' : ''}`)
}
for (const l of headerLines) log(`  ${l}`)
assert.deepEqual(headerEvents.filter(e => e.type === 'request/header').map(e => e.type === 'request/header' ? e.data.reason : ''), ['initial', 'change', 'series'])

log('8. a sandbox mode switch is one more line in the same file')
const filesBefore = files(root).length
setSandboxMode(agent.session, 'workspace-write')
await ctx.sessions.flush(agent.session)
const modeLine = readFileSync(sessionFile(root, hid), 'utf8').trim().split('\n').at(-1) ?? ''
log(`  last line: ${modeLine.replace(/"time":\d+/, '"time":<ms>')}`)
log(`  files under the root: ${filesBefore} -> ${files(root).length}; overrideOf(session) = ${ctx.sandboxPolicy.overrideOf(agent.session)}`)
assert.equal((JSON.parse(modeLine) as SessionEvent).type, 'sandbox/mode')
assert.equal(files(root).length, filesBefore)

log('9. an out-of-repo plugin appends its own event type: written fine, unreadable after restart')
const auditSeq = agent.session.append('release/audit' as 'sandbox/mode', { note: 'payment-api 1.4.2 rolled back' } as never).seq
await ctx.sessions.flush(agent.session)
log(`  append accepted at seq ${auditSeq}; last line on disk: ${readFileSync(sessionFile(root, hid), 'utf8').trim().split('\n').at(-1)?.replace(/"time":\d+/, '"time":<ms>')}`)
await ctx.fiber.dispose()
{
  const reader = new Context()
  await reader.plugin(SessionStore)
  await reader.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await assert.rejects(async () => {
    const handle = await reader.sessionPersistence.open(hid, 'read')
    await handle.read()
  }, (e: Error) => {
    log(`  same dsh, reopen: ${e.message.split(' — ')[0]}`)
    return /release\/audit/.test(e.message)
  })
  await reader.fiber.dispose()
}

log('10. zstd (the default): a torn last frame gives up only what it cannot decode')
const zroot = mkdtempSync(join(tmpdir(), 'dsh-session-demo-zstd-'))
process.once('exit', () => { rmSync(zroot, { recursive: true, force: true }) })
const zid = SessionId('zstd-demo')
;({ ctx, agent } = await boot([callTool('call-z1', 'lookup_release', { service: 'payment-api' }), reply('demo-003 失败。')], { id: zid, dir: zroot, compression: 'zstd' }))
await ask(ctx, agent, 'payment-api 最近一次发布怎么样？')
await ctx.fiber.dispose()
;({ ctx, agent } = await boot([callTool('call-z2', 'lookup_release', { service: 'order-api' }), reply('demo-007 成功。')], { id: zid, dir: zroot, compression: 'zstd' }))
await ask(ctx, agent, 'order-api 呢？')
const committed = agent.session.snapshotEvents().length
await ctx.fiber.dispose()
const zfile = sessionFile(zroot, zid, 'jsonl.zstd')
const bytes = readFileSync(zfile)
const frames: number[] = []
for (let i = 0; i + 4 <= bytes.length; i++) if (bytes.readUInt32LE(i) === 0xFD2FB528) frames.push(i)
const lastFrame = frames.at(-1) ?? 0
log(`  two turns across a restart: ${frames.length} zstd frames (header + one per append batch), ${committed} events`)
const zstdTest = (file: string) => spawnSync('zstd', ['-t', file], { encoding: 'utf8' }).status
const tears: [string, number][] = [['drop the 4-byte checksum', bytes.length - 4], ['cut the last frame in half', lastFrame + Math.floor((bytes.length - lastFrame) / 2)]]
const survivors: number[] = []
for (const [label, cut] of tears) {
  const copy = mkdtempSync(join(tmpdir(), 'dsh-session-demo-zstd-copy-'))
  process.once('exit', () => { rmSync(copy, { recursive: true, force: true }) })
  cpSync(zroot, copy, { recursive: true })
  const torn = sessionFile(copy, zid, 'jsonl.zstd')
  truncateSync(torn, cut)
  const tornStatus = zstdTest(torn)
  const reader = new Context()
  await reader.plugin(SessionStore)
  await reader.plugin(JsonlSessionPersistence, { root: copy })
  const handle = await reader.sessionPersistence.open(zid, 'read')
  const { events } = await handle.read()
  await handle.close()
  await reader.fiber.dispose()
  ;({ ctx, agent } = await boot([reply('好的。')], { id: zid, dir: copy, compression: 'zstd' }))
  await ctx.sessions.flush(agent.session)
  const resumedCount = agent.session.snapshotEvents().length
  const resumedStatus = zstdTest(torn)
  await ask(ctx, agent, '继续')
  const nextCount = agent.session.snapshotEvents().length
  await ctx.fiber.dispose()
  survivors.push(events.length)
  log(`  ${label}: zstd -t exit ${tornStatus}`)
  log(`    read ${events.length} events, last=${events.at(-1)?.type}; resumed ${resumedCount} events, zstd -t exit ${resumedStatus}; one more turn ${nextCount} events, zstd -t exit ${zstdTest(torn)}`)
  assert.notEqual(tornStatus, 0)
  assert.equal(zstdTest(torn), 0, 'the next write repairs the torn tail')
}
assert.deepEqual(survivors, [committed, 17], 'only the torn frame\'s undecodable events are lost')

log('11. every append is written, then fsync-ed, before it counts (strace)')
const trace = join(tmpdir(), `dsh-session-demo-strace-${process.pid}.txt`)
process.once('exit', () => { rmSync(trace, { force: true }) })
const traced = spawnSync('strace', ['-f', '-y', '-s', '0', '-e', 'trace=write,fsync,fdatasync,link', '-o', trace,
  process.execPath, ...process.execArgv, fileURLToPath(import.meta.url), 'fsync-child'], { encoding: 'utf8' })
if (traced.error) {
  log(`  (strace not available: ${traced.error.message})`)
} else {
  assert.equal(traced.status, 0)
  const calls = readFileSync(trace, 'utf8').split('\n')
    .map(l => /^\d+ +(write|fsync|fdatasync|link)\((?:\d+<([^>]*)>|"([^"]*)")(?:, (?:""\.\.\.|"[^"]*"), (\d+))?/.exec(l))
    .flatMap(m => m ? [{ call: m[1] ?? '', path: m[2] ?? m[3] ?? '', size: m[4] }] : [])
    .filter(c => c.path.includes('/_no-cwd/'))
  const short = (path: string) => path.replace(/^.*\/_no-cwd\//, '').replace(/\.[0-9a-f]{12}\.tmp$/, '.<rand>.tmp')
  for (const c of calls) log(`  ${c.call.padEnd(6)} ${short(c.path)}${c.size ? ` ${c.size} bytes` : ''}`)
  const writes = calls.flatMap((c, i) => c.call === 'write' ? [i] : [])
  assert.ok(writes.length >= 2)
  for (const i of writes) assert.ok(calls[i + 1]?.call === 'fsync' && calls[i + 1]?.path === calls[i]?.path, 'each write is followed by fsync of the same file')
}

process.exit(0)
