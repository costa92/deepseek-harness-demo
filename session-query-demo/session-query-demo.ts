/** Find every session that mentions demo-003, trace fork lineage, and see what full-text search can and cannot match. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

// 第一段：用真实 agent 循环写出 5 个会话，其中 3 个是 fork。
const A = SessionId('oncall-payment')
const B = SessionId('oncall-order')
const C = SessionId('oncall-payment-rca')
const D = SessionId('oncall-payment-review')
const E = SessionId('oncall-order-idle')
{
  const ctx = await base()
  const model = new ScriptedModel([
    callTool('call-1', 'lookup_release', { service: 'payment-api' }), reply('demo-003 在灰度阶段健康检查失败，已自动回滚。'),
    callTool('call-2', 'lookup_release', { service: 'order-api' }), reply('order-api 最近一次发布 demo-007 成功。'),
    reply('先修复健康检查，再重新发布 demo-003。'),
    reply('复盘：灰度健康检查拦住了问题版本，回滚耗时不到一分钟。'),
  ])
  ctx.llm.registerAdapter(['mock'], model)
  ctx.tools.register(lookupRelease)
  await ctx.plugin(AgentLoop, { agents: [] })
  const agentOptions = { provider: 'mock', model: 'mock' }
  const ask = async (agent: Agent, text: string) => {
    const idle = new Promise<void>((resolve) => {
      const off = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { off(); resolve() }
      })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await idle
    await ctx.sessions.flush(agent.session)
  }
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

await ctx.fiber.dispose()
process.exit(0)
