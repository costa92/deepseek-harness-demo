/** Find every session that mentions demo-003, trace fork lineage, and see what full-text search can and cannot match. */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as checkpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import type { SessionLineageNode } from '@deepseek-ai/dsh-session-query'
import * as ToolSessionQuery from '@deepseek-ai/dsh-tool-session-query'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'

const log = (msg: string) => { console.log(msg) }
const root = mkdtempSync(join(tmpdir(), 'dsh-session-query-demo-'))
process.once('exit', () => { rmSync(root, { recursive: true, force: true }) })

/** A model that replays a fixed script. */
class ScriptedModel extends LlmAdapter {
  constructor(readonly script: StreamChunk[][]) { super() }
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

const records: Record<string, string> = {
  'payment-api': 'demo-003 payment-api failed：灰度阶段健康检查失败，已自动回滚',
  'order-api': 'demo-007 order-api succeeded',
  'search-api': 'demo-120 search-api succeeded after canary; rollback-window closed at 18:05 without incidents',
}
const lookupRelease = defineTool({
  name: 'lookup_release',
  description: 'Query synthetic release history for one service.',
  parameters: { service: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { line: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: value.line }],
  },
  async execute(args) { return { line: records[args.service] ?? 'no releases' } },
})

const base = async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(checkpointPolicy)
  return ctx
}
const agentOptions = { provider: 'mock', model: 'mock' }
const askIn = async (ctx: Context, agent: Agent, text: string) => {
  const idle = new Promise<void>((resolve) => {
    const off = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { off(); resolve() }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
  await ctx.sessions.flush(agent.session)
}

// 第一段：用真实 agent 循环写出 5 个会话，其中 3 个是 fork。
const A = SessionId('oncall-payment')
const B = SessionId('oncall-order')
const C = SessionId('oncall-payment-rca')
const D = SessionId('oncall-payment-review')
const E = SessionId('oncall-order-idle')
const S = SessionId('oncall-search-api')
const WA = SessionId('ws-a-deploy')
const WB = SessionId('ws-b-deploy')
{
  const ctx = await base()
  const model = new ScriptedModel([
    callTool('call-1', 'lookup_release', { service: 'payment-api' }), reply('demo-003 在灰度阶段健康检查失败，已自动回滚。'),
    callTool('call-2', 'lookup_release', { service: 'order-api' }), reply('order-api 最近一次发布 demo-007 成功。'),
    reply('先修复健康检查，再重新发布 demo-003。'),
    reply('复盘：灰度健康检查拦住了问题版本，回滚耗时不到一分钟。'),
    callTool('call-3', 'lookup_release', { service: 'search-api' }), reply('search-api 最近一次发布 demo-120 成功。'),
    reply('demo-201 已上线。'), reply('demo-201 已上线。'),
  ])
  ctx.llm.registerAdapter(['mock'], model)
  ctx.tools.register(lookupRelease)
  await ctx.plugin(TokenMeter)
  // 阈值调小：60 个码点以上的工具结果只留头尾各 10 个。
  await ctx.plugin(ToolResultPruner, { thresholdChars: 60, headChars: 10, tailChars: 10 })
  await ctx.plugin(AgentLoop, { agents: [] })
  const ask = (agent: Agent, text: string) => askIn(ctx, agent, text)
  // 与 session-controller 的 fork 相同：以父日志到最后一个 turn/end 为种子创建子会话。
  const fork = async (parent: Agent, id: SessionId) => {
    // oxlint-disable-next-line typescript/no-deprecated -- the demo copies the whole parent log on purpose
    const events = parent.session.snapshotEvents()
    const cut = events.findLastIndex(e => e.type === 'turn/end') + 1
    return (await ctx.agents.create({
      sessionId: id,
      seed: events.slice(0, cut),
      inheritedEventCount: SessionLogOffset(cut),
      meta: { parentSession: parent.session.id, isSeeded: true },
      agentOptions,
    })).agent
  }
  const a = (await ctx.agents.create({ sessionId: A, agentOptions })).agent
  await ask(a, 'payment-api 最近一次发布怎么样？')
  const b = (await ctx.agents.create({ sessionId: B, agentOptions })).agent
  await ask(b, 'order-api 最近一次发布怎么样？')
  const c = await fork(a, C)
  await ask(c, '回滚之后要不要重新发布？')
  const d = await fork(c, D)
  await ask(d, '写一份复盘')
  // 只 fork、不再对话的分支。
  await ctx.sessions.flush((await fork(b, E)).session)
  // 第 8 步用：工具结果被剪枝器遮住的会话。
  const s = (await ctx.agents.create({ sessionId: S, agentOptions })).agent
  await ask(s, 'search-api 最近一次发布怎么样？')
  const pruner = ctx.get('toolResultPruner')
  assert.ok(pruner)
  assert.equal(pruner.pruneSession(s.session).pruned.length, 1)
  await ctx.sessions.flush(s.session)
  // 第 11 步用：两个工作区各一个会话。
  for (const [id, ws] of [[WA, 'ws-a'], [WB, 'ws-b']] as const) {
    await ask((await ctx.agents.create({ sessionId: id, agentOptions, meta: { cwd: join(root, ws) } })).agent, 'demo-201 上线了吗？')
  }
  await ctx.fiber.dispose()
}

// 第二段：换一个进程的视角，只剩磁盘上的日志，挂上全文搜索后端。
const ctx = await base()
await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'session-search.db') })
const q = ctx.sessionQuery
const inherited = new Map<SessionId, number>()
for (const record of await q.listSessions()) {
  inherited.set(record.header.id, (await q.readSurface(record.header.id)).inheritedEventCount)
}

log('1. which sessions mention demo-003?')
const page = await q.searchSessions({ query: 'demo-003' })
for (const hit of page.items) {
  const m = hit.bestMatch
  const own = m.seq >= (inherited.get(hit.header.id) ?? 0)
  log(`  ${hit.header.id.padEnd(22)} best seq ${String(m.seq).padStart(2)} ${m.type.padEnd(17)} ${own ? 'own      ' : 'inherited'} ${JSON.stringify(m.snippet)}`)
}
const hits = page.items.map(h => h.header.id)
assert.deepEqual([...hits].sort(), [A, C, D].sort(), 'forks match on the copy they inherited')
assert.ok(!hits.includes(B))
const review = page.items.find(h => h.header.id === D)
assert.ok(review && review.bestMatch.seq < (inherited.get(D) ?? 0), 'the review session never said demo-003 itself')

log('2. Chinese words inside a sentence are not tokens')
for (const query of ['回滚', '健康检查', '已自动回滚', '灰度阶段健康检查失败']) {
  const found = await q.searchSessions({ query })
  log(`  searchSessions(${JSON.stringify(query).padEnd(12)}) -> ${found.items.length} session(s)`)
}
const counts = await Promise.all(['回滚', '健康检查', '已自动回滚', '灰度阶段健康检查失败'].map(async query => (await q.searchSessions({ query })).items.length))
assert.deepEqual(counts, [0, 0, 3, 3])
const scanned = await q.filterEvents(A, [{ kind: 'text', text: '回滚' }])
log(`  filterEvents(${A}, text "回滚") -> seqs ${JSON.stringify(scanned.map(e => e.seq))} (${scanned.map(e => e.type).join(', ')})`)
assert.deepEqual(scanned.map(e => e.seq), [10, 13], 'the substring scan finds what full-text search misses')

log('3. lineage: who forked from whom')
const printTree = (nodes: readonly SessionLineageNode[], depth: number): void => {
  for (const node of nodes) {
    log(`  ${'  '.repeat(depth)}└─ ${node.session.header.id}`)
    printTree(node.descendants, depth + 1)
  }
}
const fromRoot = await q.traceSession(A)
log(`  ${fromRoot.target.header.id} (complete=${String(fromRoot.complete)})`)
printTree(fromRoot.descendants, 0)
const fromLeaf = await q.traceSession(D)
log(`  traceSession(${D}): ancestors ${JSON.stringify(fromLeaf.ancestors.map(r => r.header.id))} root=${fromLeaf.complete ? fromLeaf.root.header.id : '?'}`)
assert.deepEqual(fromLeaf.ancestors.map(r => r.header.id), [C, A])
rmSync(join(root, '_no-cwd', A), { recursive: true, force: true })
const orphaned = await q.traceSession(D)
log(`  after deleting ${A}'s log: complete=${String(orphaned.complete)}${orphaned.complete ? '' : ` unresolvedParentId=${orphaned.unresolvedParentId}`}`)
assert.ok(!orphaned.complete && orphaned.unresolvedParentId === A)
const afterDelete = (await q.searchSessions({ query: 'demo-003' })).items.map(h => h.header.id)
log(`  searchSessions("demo-003") now -> ${JSON.stringify(afterDelete)}`)
assert.deepEqual([...afterDelete].sort(), [C, D].sort(), 'the index follows the logs on disk')

log('4. from a hit to its neighbourhood: the tool result and the call it answers')
const inC = await q.searchEvents({ sessionId: C, query: 'failed' })
const hit = inC.items[0]
assert.ok(hit)
const trace = await q.traceEvent({ sessionId: C, seq: hit.seq })
const window = await q.readEvent({ sessionId: C, seq: hit.seq, before: 1, after: 1 })
log(`  searchEvents(${C}, "failed") -> seq ${hit.seq} ${hit.type} surface=${hit.surface}`)
log(`  traceEvent: sourceEventSeqs ${JSON.stringify(trace.sourceEventSeqs)} derivedEventSeqs ${JSON.stringify(trace.derivedEventSeqs)}`)
log(`  readEvent window: ${window.events.map((e: SessionEvent) => `${e.seq} ${e.type}`).join(' | ')}`)
const source = window.events.find(e => e.seq === trace.sourceEventSeqs[0])
assert.equal(source?.type, 'tool/call')

log('5. readSession() cannot read any persisted fork')
const readable = await q.readSession(B)
log(`  readSession(${B}): ${readable.events.length} events`)
await assert.rejects(q.readSession(C), (e: Error) => {
  log(`  readSession(${C}): ${e.message}`)
  return e.message === 'seeded session constructor seed must equal its inherited prefix'
})
await assert.rejects(q.readSession(E), (e: Error) => {
  log(`  readSession(${E}) (forked, never used): ${e.message}`)
  return e.message === 'seeded session constructor seed must equal its inherited prefix'
})
const surface = await q.readSurface(C)
log(`  readSurface(${C}): ${surface.events.length} surface events, inheritedEventCount=${surface.inheritedEventCount}`)
assert.equal(surface.inheritedEventCount, 16)
assert.equal(readable.events.length, 16)

log('6. the base bundle config: search refused, exact reads and lineage still served')
const baseYml = readFileSync(fileURLToPath(new URL('../../packages/bundle/base/cordis.patch.yml', import.meta.url)), 'utf8')
const row = baseYml.slice(baseYml.indexOf('- id: session-query-sqlite')).split('\n').slice(0, 5).map(l => l.trim())
log(`  base/cordis.patch.yml: ${row.join(' | ')}`)
const toolRows = baseYml.split('\n').filter(l => l.includes('dsh-tool-session-query')).length
log(`  rows naming dsh-tool-session-query in the same file: ${toolRows}`)
assert.ok(row.includes("path: ':memory:'") && row.includes('openAt: never'))
assert.equal(toolRows, 0)
const off = await base()
await off.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' })
const codeOf = async (call: () => Promise<unknown>) => call().then(() => 'ok', (e: Error & { code?: string }) => e.code ?? e.message)
const disabled = [await codeOf(() => off.sessionQuery.searchSessions({ query: 'demo-003' })), await codeOf(() => off.sessionQuery.searchEvents({ sessionId: C, query: 'failed' }))]
log(`  searchSessions -> ${disabled[0]}; searchEvents -> ${disabled[1]}`)
const offSurface = await off.sessionQuery.readSurface(C)
const offTrace = await off.sessionQuery.traceSession(E)
log(`  readSurface(${C}): inheritedEventCount=${offSurface.inheritedEventCount}; traceSession(${E}): ancestors ${JSON.stringify(offTrace.ancestors.map(r => r.header.id))} complete=${String(offTrace.complete)}`)
assert.deepEqual(disabled, ['SESSION_QUERY_SEARCH_DISABLED', 'SESSION_QUERY_SEARCH_DISABLED'])
assert.ok(offSurface.inheritedEventCount === 16 && offTrace.complete && offTrace.ancestors[0]?.header.id === B)
await off.fiber.dispose()

log('7. the trigram tokenizer (probed directly in node:sqlite) still misses a two-character word')
const probe = new DatabaseSync(':memory:')
probe.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize = 'trigram')")
probe.prepare('INSERT INTO t(body) VALUES (?)').run('demo-003 在灰度阶段健康检查失败，已自动回滚。')
const trigram = ['回滚', '健康检查', '自动回滚'].map((word) => {
  const { n } = probe.prepare('SELECT count(*) AS n FROM t WHERE t MATCH ?').get(`"${word}"`) as { n: number }
  return [word, n] as const
})
log(`  ${trigram.map(([word, n]) => `"${word}" -> ${n}`).join('  ')}`)
assert.deepEqual(trigram.map(([, n]) => n), [0, 1, 1])
probe.close()

log('8. content hidden from the model by pruning is still searchable, marked shadowed')
for (const query of ['rollback-window', 'demo-120']) {
  const found = await q.searchEvents({ sessionId: S, query })
  log(`  searchEvents(${S}, ${JSON.stringify(query)}) -> ${found.items.map(h => `seq ${h.seq} ${h.type} ${h.surface}`).join(', ')}`)
}
const shadowed = (await q.searchEvents({ sessionId: S, query: 'rollback-window' })).items
assert.deepEqual(shadowed.map(h => [h.type, h.surface]), [['tool/result', 'shadowed']])

log('9. reconciliation picks up content written after the first search')
log(`  searchSessions("demo-042") -> ${(await q.searchSessions({ query: 'demo-042' })).items.length} session(s)`)
{
  const writer = await base()
  writer.llm.registerAdapter(['mock'], new ScriptedModel([reply('demo-042 order-api 发布成功。')]))
  await writer.plugin(AgentLoop, { agents: [] })
  const { agent } = await writer.agents.resume({ resumeSessionId: B, agentOptions })
  await askIn(writer, agent, '再看一下 demo-042')
  await writer.fiber.dispose()
}
const appended = (await q.searchSessions({ query: 'demo-042' })).items.map(h => h.header.id)
log(`  another context resumes ${B} and writes demo-042; the same query service now -> ${JSON.stringify(appended)}`)
assert.deepEqual(appended, [B])

log('10. a live session is searched from memory; a live fork fails readSession() too')
ctx.llm.registerAdapter(['mock'], new ScriptedModel([]))
await ctx.plugin(AgentLoop, { agents: [] })
const L = SessionId('oncall-live')
const live = ctx.sessions.create(L)
live.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'demo-077 还在灰度中' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
const liveHits = (await q.searchSessions({ query: 'demo-077' })).items.map(h => h.header.id)
const liveRecord = (await q.listSessions()).find(r => r.header.id === L)
log(`  unflushed event in ${L}: on disk ${String(existsSync(join(root, '_no-cwd', L)))}; searchSessions("demo-077") -> ${JSON.stringify(liveHits)}; record ${JSON.stringify({ live: liveRecord?.live, persisted: liveRecord?.persisted })}`)
assert.deepEqual(liveHits, [L])
const bEvents = (await q.readSession(B)).events
const cutB = bEvents.findLastIndex(e => e.type === 'turn/end') + 1
const F = SessionId('oncall-order-live-fork')
await ctx.agents.create({ sessionId: F, seed: bEvents.slice(0, cutB), inheritedEventCount: SessionLogOffset(cutB), meta: { parentSession: B, isSeeded: true }, agentOptions })
await assert.rejects(q.readSession(F), (e: Error) => {
  log(`  readSession(${F}) (live, never flushed): ${e.message}`)
  return e.message === 'seeded session constructor seed must equal its inherited prefix'
})

log('11. tool-session-query: the caller agent\'s cwd decides what the model may see')
await ctx.plugin(ToolSessionQuery)
const callerA = (await ctx.agents.create({ sessionId: SessionId('ws-a-caller'), agentOptions, meta: { cwd: join(root, 'ws-a') } })).agent
const callerNone = (await ctx.agents.create({ sessionId: SessionId('no-cwd-caller'), agentOptions })).agent
let callNo = 0
const runTool = async (agent: Agent, name: string, args: Record<string, string>) => {
  const result = await ctx.tools.execute({ callId: ToolCallId(`q-${++callNo}`), name, arguments: args, agent, signal: new AbortController().signal })
  const text = result.content.map(b => b.type === 'text' ? b.text : '').join('')
  const outcome = result.isError
    ? `${String(result.error?.info?.code)}: ${result.error?.message}`
    : `${text.split('\n')[0]} ${JSON.stringify([...text.matchAll(/Session (\S+) —/g)].map(m => m[1]))}`
  log(`  ${agent.session.id.padEnd(13)} ${name}(${JSON.stringify(args)}) -> ${outcome}`)
  return result
}
const ok = await runTool(callerA, 'session_search', { query: 'demo-201' })
const cross = await runTool(callerA, 'session_trace', { session_id: WB })
const blind = await runTool(callerNone, 'session_search', { query: 'demo-003' })
const blindTrace = await runTool(callerNone, 'session_trace', { session_id: B })
assert.ok(!ok.isError && ok.content.some(b => b.type === 'text' && b.text.includes(`Session ${WA} —`) && !b.text.includes(WB)))
for (const r of [cross, blind, blindTrace]) assert.equal(r.error?.info?.code, 'SESSION_QUERY_TOOL_UNAUTHORIZED')

await ctx.fiber.dispose()
process.exit(0)
