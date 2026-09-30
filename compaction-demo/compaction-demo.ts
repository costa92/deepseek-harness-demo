/** Flood the context with release records and watch dsh prune, summarize, and recover from overflow. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, foldSurface, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as checkpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'

const log = (msg: string) => { console.log(msg) }
const sid = SessionId('oncall-demo')
const [, , role, childDir] = process.argv
const root = role === 'child' && childDir ? childDir : mkdtempSync(join(tmpdir(), 'dsh-compaction-demo-'))
if (role !== 'child') process.once('exit', () => { rmSync(root, { recursive: true, force: true }) })

type Reply = StreamChunk[] | 'overflow'
/** Scripted answer to one summary request: text, a provider failure, or a request that never returns. */
type Summary = string | 'fail' | 'hang'
const DEFAULT_SUMMARY = '## Primary Request and Intent\n- check recent releases of payment-api, order-api, user-api'
/** A model with a small context window that replays a fixed script and answers summary requests. */
class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly summaries: Summary[] = []
  onHang?: () => Promise<void>
  constructor(readonly script: Reply[]) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 2000 } })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.purpose === 'compaction') {
      const summary = this.summaries.shift() ?? DEFAULT_SUMMARY
      if (summary === 'fail') {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'summary backend unavailable', code: 'SERVER_ERROR' } } }
        return
      }
      if (summary === 'hang') {
        await this.onHang?.()
        await new Promise(() => {})
      }
      yield* reply(summary)
      return
    }
    const entry = this.script.shift()
    assert.ok(entry, 'the scripted model ran out of replies')
    if (entry === 'overflow') {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'prompt exceeds the context window', code: 'CONTEXT_WINDOW_EXCEEDED' } } }
      return
    }
    for (const chunk of entry) yield chunk
  }
}
const reply = (text: string, usage = { inputTokens: 10, outputTokens: 5 }): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage },
  { type: 'finish', reason: { kind: 'stop' } },
]
const callTool = (rawId: string, name: string, args: object, usage = { inputTokens: 10, outputTokens: 5 }): StreamChunk[] => {
  const id = ToolCallId(rawId)
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** 40 synthetic release records per service, about 2.6K characters of tool output. */
const releases = (service: string) => Array.from({ length: 40 }, (_, i) => {
  const n = String(i + 1).padStart(3, '0')
  return `demo-${n} ${service} 1.${i}.0 ${i % 7 === 3 ? 'failed ' : 'success'} 2026-09-${String(1 + (i % 28)).padStart(2, '0')}`
})
const linesSchema = { type: 'object', additionalProperties: false, properties: { lines: { type: 'array', items: { type: 'string' }, required: true } } } as const
const lookupRelease = defineTool({
  name: 'lookup_release',
  description: 'Query synthetic release history for one service.',
  parameters: { service: { type: 'string', required: true } },
  output: {
    schema: linesSchema,
    render: (_args, value) => [{ type: 'text', text: value.lines.join('\n') }],
  },
  async execute(args) { return { lines: releases(args.service) } },
})

/** The same plugin set for every scenario; later steps boot fresh contexts with other compaction settings. */
const boot = async (dir: string, model: ScriptedModel, compaction: object = {}) => {
  const c = new Context()
  await c.plugin(LlmRuntime)
  await c.plugin(SessionStore)
  await c.plugin(SessionProjectionRegistry)
  await c.plugin(SystemPrompt)
  await c.plugin(ToolRuntime)
  await c.plugin(AgentRegistry)
  await c.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
  await c.plugin(checkpointPolicy)
  await c.plugin(TokenMeter)
  await c.plugin(ToolResultPruner, { thresholdChars: 1200, headChars: 600, tailChars: 200 })
  await c.plugin(BasicCompactionEngine, compaction)
  c.llm.registerAdapter(['mock'], model)
  c.tools.register(lookupRelease)
  await c.plugin(AgentLoop, { agents: [] })
  return c
}
const agentOptions = { provider: 'mock', model: 'mock' }
const askIn = async (c: Context, a: Agent, text: string) => {
  const idle = new Promise<void>((resolve) => {
    const off = c.on('agent/status', ({ agent: subject, status }) => {
      if (subject === a && status === 'idle') { off(); resolve() }
    })
  })
  a.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
  await c.sessions.flush(a.session)
}
/** Plain Q&A turns with long answers, enough to push a 2000-token window over its threshold. */
const chat = async (c: Context, m: ScriptedModel, a: Agent, turns: number, answerChars = 1800) => {
  for (let i = 1; i <= turns; i++) {
    m.script.push(reply(`第 ${i} 次回答：`.padEnd(answerChars, 'x')))
    await askIn(c, a, `第 ${i} 个问题`)
  }
}

if (role === 'child') {
  // 子进程：压到一半，摘要请求永不返回；先把 compaction/start 刷到磁盘，再通知父进程来杀。
  const m = new ScriptedModel([])
  m.summaries.push('hang')
  const c = await boot(root, m)
  const { agent: a } = await c.agents.create({ sessionId: SessionId('crash-demo'), agentOptions })
  m.onHang = async () => {
    await c.sessions.flush(a.session)
    process.stdout.write('SUMMARIZING\n')
  }
  setInterval(() => {}, 1000)
  await chat(c, m, a, 5)
  await new Promise(() => {})
}

const model = new ScriptedModel([])
const ctx = await boot(root, model)
const { agent } = await ctx.agents.create({ sessionId: sid, agentOptions })
const ask = (a: Agent, text: string) => askIn(ctx, a, text)
// oxlint-disable-next-line typescript/no-deprecated -- the demo reads the whole log on purpose
const events = (): readonly SessionEvent[] => agent.session.snapshotEvents()
const tokens = () => ctx.tokenMeter.measure(agent.session).totalTokens
const textOf = (content: readonly { type: string; text?: string }[]) => content.map(b => b.text ?? '').join('')
const resultText = (e: SessionEvent) => e.type === 'tool/result'
  ? textOf((e.data.message.content[0] as { content: { type: string; text?: string }[] }).content)
  : ''
const lookup = async (service: string) => {
  model.script.push(callTool(`call-${service}`, 'lookup_release', { service }), reply(`${service} 最近 40 次发布里有失败。`))
  const before = events().length
  await ask(agent, `${service} 最近的发布怎么样？`)
  const landed = events().slice(before)
  const pruned = landed.filter(e => e.type === 'compaction/prune').length
  const summary = landed.find(e => e.type === 'compaction/summary')
  log(`  ${service.padEnd(11)} surface nodes=${String(agent.session.surface.nodes.length).padStart(2)} est. tokens=${String(tokens()).padStart(4)}`
    + `${pruned ? `  pruned ${pruned} tool result(s)` : ''}${summary ? '  + summary' : ''}`)
  return landed
}
const failedIn = (text: string) => text.split('\n').filter(l => l.includes('failed')).map(l => l.split(' ')[0])

log('1. five large lookups against a 2000-token window: pressure first prunes tool results')
const threshold = Math.floor(2000 * 0.8)
log(`  threshold = 2000 x 0.8 = ${threshold} tokens; pruner keeps head 600 + tail 200 chars of results over 1200`)
let landed: readonly SessionEvent[] = []
for (const service of ['payment-api', 'order-api', 'user-api', 'cart-api', 'search-api']) landed = [...landed, ...await lookup(service)]
const prunes = landed.filter(e => e.type === 'tool/result' && typeof e.surfaceOp === 'object')
assert.equal(prunes.length, 5, 'every large result was pruned once pressure crossed the threshold')
const original = events().find(e => e.type === 'tool/result' && e.data.message.source.callId === 'call-payment-api' && e.surfaceOp === 'append')
const replacement = prunes[0]
assert.ok(original && replacement)
const full = resultText(original)
const seen = resultText(replacement)
log(`  payment-api result seq ${original.seq} (${full.length} chars) shadowed by seq ${replacement.seq} (${seen.length} chars)`)
log(`    failed releases in the log:        ${failedIn(full).join(' ')}`)
log(`    failed releases the model now sees: ${failedIn(seen).join(' ')}`)
assert.ok(seen.includes('[... tool result middle pruned ...]'))
assert.ok(failedIn(seen).length < failedIn(full).length, 'records in the pruned middle are invisible to the model')

log('2. still over the threshold after pruning: summarize the old span into one checkpoint')
landed = []
for (const service of ['auth-api', 'notify-api']) landed = [...landed, ...await lookup(service)]
const start = landed.find(e => e.type === 'compaction/start')
const summary = landed.find(e => e.type === 'compaction/summary')
const checkpoint = landed.find(e => e.type === 'user/message' && typeof e.surfaceOp === 'object')
const end = landed.find(e => e.type === 'compaction/end')
assert.ok(start && summary?.type === 'compaction/summary' && checkpoint?.type === 'user/message' && end)
log(`  seq ${start.seq} compaction/start -> ${summary.seq} compaction/summary -> ${checkpoint.seq} user/message (replace) -> ${end.seq} compaction/end`)
log(`  shadowed ${summary.data.shadowedSeqs.length} surface nodes, surface span seq ${summary.data.shadowedRange.start}..${summary.data.shadowedRange.end}, ~${summary.data.shadowedTokenCount} tokens`)
const summarize = model.requests.find(r => r.purpose === 'compaction')
assert.ok(summarize)
const lastInstruction = textOf(summarize.messages.at(-1)?.content ?? [])
log(`  summary request: ${summarize.messages.length} messages (system + shadowed span + instruction), tools=${summarize.tools?.length ?? 0}`)
log(`    instruction starts: ${JSON.stringify(lastInstruction.slice(0, 72))}`)
const next = model.requests.filter(r => r.purpose !== 'compaction').at(-1)
assert.ok(next)
log(`  next model request: ${next.messages.length} messages, roles ${next.messages.map(m => m.role[0]).join('')}`)
log(`    message 2 starts: ${JSON.stringify(textOf(next.messages[1]?.content ?? []).slice(0, 72))}`)
// 切点只保证工具调用与结果成对，不保证整轮：search-api 这一轮的提问进了摘要，调用和结果原样保留。
const keptFrom = agent.session.surface.nodes[2]
const asked = events().find(e => e.type === 'user/message' && textOf(e.data.content).startsWith('search-api'))
assert.ok(keptFrom !== undefined && asked)
log(`  retained tail starts at seq ${keptFrom} (${events()[keptFrom]?.type}); the search-api question, seq ${asked.seq}, is inside the summary`)
assert.ok(asked.seq <= summary.data.shadowedRange.end && keptFrom > summary.data.shadowedRange.end)
assert.ok(textOf(next.messages[1]?.content ?? []).includes('<compacted-summary>'))

log('3. provider says the prompt is too long: compact once, then retry')
model.script.push('overflow', reply('压缩后重试成功。'))
let before = events().length
await ask(agent, '把所有服务的失败发布汇总一下')
let turn = events().slice(before)
const kinds = (list: readonly SessionEvent[]) => list.filter(e => ['assistant/attempt', 'compaction/start', 'compaction/end', 'assistant/message', 'turn/end'].includes(e.type))
  .map(e => e.type === 'turn/end' ? `turn/end(${e.data.reason.kind})` : e.type)
log(`  ${kinds(turn).join(' > ')}; surface now ${agent.session.surface.nodes.length} nodes`)
assert.deepEqual(kinds(turn), ['assistant/attempt', 'compaction/start', 'compaction/end', 'assistant/message', 'turn/end(completed)'])
model.script.push('overflow', 'overflow')
before = events().length
await ask(agent, '再汇总一次')
turn = events().slice(before)
const endEvent = turn.at(-1)
log(`  twice in a row: ${kinds(turn).join(' > ')}; surface now ${agent.session.surface.nodes.length} nodes`)
assert.ok(endEvent?.type === 'turn/end' && endEvent.data.reason.kind === 'error', 'maxOverflowRetries defaults to 1')

log('4. nothing was rewritten: the file still holds every original record')
const file = readdirSync(join(root, '_no-cwd', sid)).find(f => f.endsWith('.jsonl'))
assert.ok(file)
const stored = readFileSync(join(root, '_no-cwd', sid, file), 'utf8').trim().split('\n').slice(1).map(l => JSON.parse(l) as SessionEvent)
const fullResults = stored.filter(e => e.type === 'tool/result' && resultText(e).split('\n').length === 40)
const count = (type: string) => stored.filter(e => e.type === type).length
log(`  ${stored.length} events on disk: ${count('compaction/prune')} prunes, ${count('compaction/summary')} summaries; ${fullResults.length} unpruned 40-line results still there`)
const offline = foldSurface(stored)
log(`  foldSurface(file) = live surface: ${JSON.stringify(offline.nodes) === JSON.stringify(agent.session.surface.nodes)} (${offline.nodes.length} nodes, ${offline.replacements.length} replacements)`)
assert.equal(fullResults.length, 7)
assert.deepEqual([count('compaction/prune'), count('compaction/summary')], [7, 3])
assert.deepEqual(offline.nodes, agent.session.surface.nodes)

log('5. the estimate is 4 characters per token, whatever the language')
const zh = '支付服务在灰度阶段健康检查失败触发自动回滚'.repeat(50)
const en = 'payment-api health check failed during canary '.repeat(22).slice(0, 1000)
const estimates: number[] = []
for (const [label, text, ratio] of [['1000 English chars', en, 0.3], [`${zh.length} Chinese chars`, zh, 0.6]] as const) {
  const est = ctx.tokenMeter.estimateMessage(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  estimates.push(est)
  log(`  ${label.padEnd(18)} estimate ${est}  vs DeepSeek's documented ratio ${ratio}/char -> ~${Math.round(text.length * ratio)}`)
}
// ceil(chars / 4) + 4（文本块开销）+ 4（角色开销）
assert.deepEqual(estimates, [Math.ceil(en.length / 4) + 8, Math.ceil(zh.length / 4) + 8])

// oxlint-disable-next-line typescript/no-deprecated -- the demo reads the whole log on purpose
const evs = (a: Agent): readonly SessionEvent[] => a.session.snapshotEvents()
const logs: string[] = []
const capture = (c: Context) => { c.logger.exporter({ levels: { default: 3 }, export: (m) => { logs.push(String(m.args[0])) } }) }

log('6. the base bundle mounts session-search storage, not the session-query tool')
const bundleDir = fileURLToPath(new URL('../../packages/bundle/', import.meta.url))
const bundles = readdirSync(bundleDir).filter(d => existsSync(join(bundleDir, d, 'cordis.patch.yml')))
const rows = (bundle: string) => [...readFileSync(join(bundleDir, bundle, 'cordis.patch.yml'), 'utf8').matchAll(/^\s*name:\s*'([^']+)'/gm)].map(m => m[1])
const baseRows = rows('base')
const withTool = bundles.filter(b => rows(b).includes('@deepseek-ai/dsh-tool-session-query'))
log(`  base/cordis.patch.yml mounts dsh-session-query-sqlite ${baseRows.includes('@deepseek-ai/dsh-session-query-sqlite')}, dsh-tool-session-query ${baseRows.includes('@deepseek-ai/dsh-tool-session-query')}`)
log(`  bundles mounting dsh-tool-session-query: ${withTool.length} of ${bundles.length} (${bundles.join(', ')})`)
assert.ok(baseRows.includes('@deepseek-ai/dsh-session-query-sqlite'))
assert.deepEqual(withTool, [], 'no bundle gives the model a tool to read the log')

log('7. still over the threshold after compactionRetries: a warning, and the request goes out anyway')
const m7 = new ScriptedModel([])
const c7 = await boot(mkdtempSync(join(root, 'retries-')), m7, { summarizationProvider: 'mock', summarizationModel: 'summarizer-mini' })
capture(c7)
const { agent: a7 } = await c7.agents.create({ sessionId: SessionId('retries-demo'), agentOptions })
await chat(c7, m7, a7, 3, 1200)
// 一条 6400 字符的提问本身就超过阈值。压力在请求前、按上一步结束时的 surface 判断，所以下一轮才动手。
m7.script.push(reply('收到清单。'))
const huge7 = evs(a7).length
await askIn(c7, a7, '附上完整的发布清单：'.padEnd(6400, 'y'))
const hugeTurn = evs(a7).slice(huge7)
log(`  the 6400-char question's own turn: ${hugeTurn.filter(e => e.type === 'compaction/start').length} compactions (pre-step measures before the new message lands)`)
assert.ok(!hugeTurn.some(e => e.type === 'compaction/start'))
// 第一次摘要 2000 字符，比被压的 3 轮小；第二次再压这份摘要。
m7.summaries.push('## Primary Request and Intent\n'.padEnd(2000, '-'), DEFAULT_SUMMARY)
m7.script.push(reply('继续。'))
const before7 = evs(a7).length
await askIn(c7, a7, '继续')
const turn7 = evs(a7).slice(before7)
const sums7 = turn7.filter(e => e.type === 'compaction/summary')
const warn7 = logs.find(l => l.startsWith('step compaction failed'))
const sent7 = m7.requests.filter(r => r.purpose !== 'compaction').at(-1)
assert.ok(warn7 && sent7)
log(`  next turn, one pre-step wrote ${sums7.length} compaction/summary events, then logger.warn:`)
log(`    ${warn7}`)
log(`  ${kinds(turn7).join(' > ')}; the request still went out with ${sent7.messages.length} messages`)
assert.equal(sums7.length, 2, 'compactionRetries defaults to 1: two attempts')
assert.ok(warn7.includes('still above threshold after 2 compaction attempts'))
assert.deepEqual(kinds(turn7), ['compaction/start', 'compaction/end', 'compaction/start', 'compaction/end', 'assistant/message', 'turn/end(completed)'])

log('8. summarizationModel swaps the model, not the instruction')
const sumReqs7 = m7.requests.filter(r => r.purpose === 'compaction')
const targets = [...new Set(sumReqs7.map(r => `${r.provider}/${r.model}`))]
const sameInstruction = sumReqs7.every(r => textOf(r.messages.at(-1)?.content ?? []) === lastInstruction)
log(`  ${sumReqs7.length} summary requests went to ${targets.join(', ')}; the conversation stays on mock/mock`)
log(`  last message identical to the default run's instruction: ${sameInstruction}`)
assert.deepEqual(targets, ['mock/summarizer-mini'])
assert.ok(sameInstruction)

log('9. a failed summary request: without a summary-error listener, with one')
const m9 = new ScriptedModel([])
const c9 = await boot(mkdtempSync(join(root, 'summary-error-')), m9)
capture(c9)
const { agent: a9 } = await c9.agents.create({ sessionId: SessionId('summary-error-demo'), agentOptions })
await chat(c9, m9, a9, 4)
m9.summaries.push('fail')
let before9 = evs(a9).length
await chat(c9, m9, a9, 1)
const endOf = (list: readonly SessionEvent[]) => list.find(e => e.type === 'compaction/end')
const failedEnd = endOf(evs(a9).slice(before9))
const nodes9 = a9.session.surface.nodes.length
assert.ok(failedEnd?.type === 'compaction/end' && failedEnd.data.error)
log(`  no listener: compaction/end carries error ${JSON.stringify(failedEnd.data.error)}`)
log(`    no summary, surface still ${nodes9} nodes; logger.warn: ${logs.filter(l => l.startsWith('step compaction failed')).at(-1)}`)
assert.equal(evs(a9).slice(before9).filter(e => e.type === 'compaction/summary').length, 0)
const recoveries: string[] = []
c9.on('compaction/summary-error', ({ sourceEventSeqs, error }, next) => {
  // 真正的恢复者（如 image-offload）要先在日志里记下输入的变化再返回 true；这里只演示重试路径，放行一次。
  if (recoveries.length > 0) return next()
  recoveries.push(`${sourceEventSeqs.length} source seqs, ${(error as Error).message}`)
  return true
})
m9.summaries.push('fail', DEFAULT_SUMMARY)
before9 = evs(a9).length
await chat(c9, m9, a9, 1)
const turn9 = evs(a9).slice(before9)
log(`  listener returns true once: called with ${recoveries.join('; ')}`)
log(`    ${turn9.filter(e => e.type.startsWith('compaction/') && e.type !== 'compaction/prune').map(e => e.type).join(' > ')}; surface now ${a9.session.surface.nodes.length} nodes`)
assert.equal(recoveries.length, 1)
assert.equal(m9.requests.filter(r => r.purpose === 'compaction').length, 3, 'one failed + one failed then retried')
assert.deepEqual(turn9.filter(e => e.type.startsWith('compaction/')).map(e => e.type), ['compaction/start', 'compaction/summary', 'compaction/end'])

log('10. kill -9 while the summary request is in flight, then resume')
const dir10 = mkdtempSync(join(root, 'crash-'))
const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), 'child', dir10], { stdio: ['ignore', 'pipe', 'inherit'] })
process.prependOnceListener('exit', () => { child.kill('SIGKILL') })
await new Promise<void>((resolve) => { child.stdout.on('data', (d: Buffer) => { if (d.toString().includes('SUMMARIZING')) resolve() }) })
const exited = new Promise<NodeJS.Signals | null>((resolve) => { child.once('exit', (_c, signal) => { resolve(signal) }) })
child.kill('SIGKILL')
log(`  child exited by ${String(await exited)}`)
const crashLog = () => {
  const d = join(dir10, '_no-cwd', 'crash-demo')
  const f = readdirSync(d).find(n => n.endsWith('.jsonl'))
  assert.ok(f)
  return readFileSync(join(d, f), 'utf8').trim().split('\n').slice(1).map(l => JSON.parse(l) as SessionEvent)
}
const crashed = crashLog()
const orphan = crashed.at(-1)
assert.ok(orphan?.type === 'compaction/start')
log(`  log ends at seq ${orphan.seq} ${orphan.type}; no compaction/end follows`)
const m10 = new ScriptedModel([])
const c10 = await boot(dir10, m10)
capture(c10)
const { agent: a10 } = await c10.agents.resume({ resumeSessionId: SessionId('crash-demo'), agentOptions })
await c10.sessions.flush(a10.session)
const appended = evs(a10).slice(crashed.length)
log(`  resume appends: ${appended.map(e => e.type === 'turn/end' ? `turn/end(${e.data.reason.kind})` : e.type).join(' > ')}`)
const before10 = evs(a10).length
await chat(c10, m10, a10, 1)
const turn10 = evs(a10).slice(before10)
log(`  next turn: ${turn10.filter(e => e.type.startsWith('compaction/') && e.type !== 'compaction/prune').map(e => e.type).join(' > ')}; busy warnings: ${logs.filter(l => l.includes('already in progress')).length}`)
assert.ok(appended.some(e => e.type === 'session/end-seed'), 'resume writes a seed boundary after the orphan')
assert.deepEqual(turn10.filter(e => e.type.startsWith('compaction/')).map(e => e.type), ['compaction/start', 'compaction/summary', 'compaction/end'], 'the stale start does not block')

log('11. with provider usage as the anchor, only content that arrived since the last call is estimated')
const zh11 = '支付服务在灰度阶段健康检查失败触发自动回滚'.repeat(50)
const m11 = new ScriptedModel([
  reply('收到。', { inputTokens: 700, outputTokens: 5 }),
  callTool('call-incident', 'read_incident', { id: 'INC-7' }, { inputTokens: 720, outputTokens: 12 }),
  reply('事故单已读。'),
])
const c11 = await boot(mkdtempSync(join(root, 'anchor-')), m11)
c11.tools.register(defineTool({
  name: 'read_incident',
  description: 'Read one synthetic incident report.',
  parameters: { id: { type: 'string', required: true } },
  output: { schema: linesSchema, render: (_args, value) => [{ type: 'text', text: value.lines.join('\n') }] },
  async execute() { return { lines: [zh11] } },
}))
const { agent: a11 } = await c11.agents.create({ sessionId: SessionId('anchor-demo'), agentOptions })
await askIn(c11, a11, zh11)
const first11 = c11.tokenMeter.measure(a11.session)
log(`  turn 1 sends ${zh11.length} Chinese chars; the call reports 700 input + 5 output`)
log(`    measure(): baseline ${first11.baseline.kind} ${first11.baseline.tokens}, total ${first11.totalTokens}`)
const preStep: { baseline: string; delta: number; total: number }[] = []
c11.on('agent/pre-step', ({ agent: subject }, next) => {
  const m = c11.tokenMeter.measure(subject.session)
  preStep.push({ baseline: `${m.baseline.kind} ${m.baseline.tokens}`, delta: m.surfaceDeltaTokens, total: m.totalTokens })
  return next()
})
await askIn(c11, a11, '看一下 INC-7')
const resultNode = c11.tokenMeter.measure(a11.session).nodes.find(n => evs(a11)[n.seq]?.type === 'tool/result')
const second11 = preStep.at(1)
assert.ok(resultNode && second11)
log(`  turn 2: the tool call reports 720 + 12; then read_incident returns another ${zh11.length} Chinese chars`)
log(`    pre-step before the next request: baseline ${second11.baseline} + delta ${second11.delta} = ${second11.total}`)
log(`    the delta is the tool result's heuristic price (${resultNode.heuristicTokens}); DeepSeek's documented ratio: ~${Math.round(zh11.length * 0.6)}`)
assert.equal(first11.baseline.kind, 'usage')
assert.equal(second11.baseline, 'usage 732')
assert.equal(second11.delta, resultNode.heuristicTokens, 'only the new tool result is estimated, at 4 characters per token')

log('12. the pruner slices by code point and keeps non-text blocks in place')
const pruner = ctx.get('toolResultPruner')
assert.ok(pruner)
const image = { type: 'image', attachment: { id: 'img-1' } } as unknown as ContentBlock
const head = `${'a'.repeat(599)}😀${'b'.repeat(100)}`
const tail = `${'c'.repeat(500)}🚀${'d'.repeat(199)}`
const out = pruner.pruneContent([{ type: 'text', text: head }, image, { type: 'text', text: tail }])
assert.ok(out)
const texts = out.filter(b => b.type === 'text').map(b => (b as { text: string }).text)
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
log(`  in: text (${[...head].length} code points, ${head.length} UTF-16 units) + image + text (${[...tail].length}, ${tail.length})`)
log(`  out: ${out.map(b => b.type).join(' + ')}; head ends ${JSON.stringify(texts[0]?.split('\n')[0]?.slice(-3))}, tail starts ${JSON.stringify(texts[1]?.slice(0, 3))}`)
log(`  a naive UTF-16 cut at 600 would end with ${JSON.stringify(head.slice(597, 600))}; lone surrogates in the output: ${texts.some(t => lone.test(t))}`)
assert.deepEqual(out.map(b => b.type), ['text', 'image', 'text'])
assert.ok(texts[0]?.split('\n')[0]?.endsWith('😀') && texts[1]?.startsWith('🚀'))
assert.ok(!texts.some(t => lone.test(t)) && lone.test(head.slice(0, 600)))

await Promise.all([c7, c9, c10, c11].map(c => c.fiber.dispose()))
await ctx.fiber.dispose()
process.exit(0)
