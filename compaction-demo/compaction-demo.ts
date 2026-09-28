/** Flood the context with release records and watch dsh prune, summarize, and recover from overflow. */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
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
const root = mkdtempSync(join(tmpdir(), 'dsh-compaction-demo-'))
process.once('exit', () => { rmSync(root, { recursive: true, force: true }) })

type Reply = StreamChunk[] | 'overflow'
/** A model with a small context window that replays a fixed script and answers summary requests. */
class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(readonly script: Reply[]) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 2000 } })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.purpose === 'compaction') {
      yield* reply('## Primary Request and Intent\n- check recent releases of payment-api, order-api, user-api')
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

/** 40 synthetic release records per service, about 2.6K characters of tool output. */
const releases = (service: string) => Array.from({ length: 40 }, (_, i) => {
  const n = String(i + 1).padStart(3, '0')
  return `demo-${n} ${service} 1.${i}.0 ${i % 7 === 3 ? 'failed ' : 'success'} 2026-09-${String(1 + (i % 28)).padStart(2, '0')}`
})
const lookupRelease = defineTool({
  name: 'lookup_release',
  description: 'Query synthetic release history for one service.',
  parameters: { service: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { lines: { type: 'array', items: { type: 'string' }, required: true } } },
    render: (_args, value) => [{ type: 'text', text: value.lines.join('\n') }],
  },
  async execute(args) { return { lines: releases(args.service) } },
})

const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
await ctx.plugin(checkpointPolicy)
await ctx.plugin(TokenMeter)
await ctx.plugin(ToolResultPruner, { thresholdChars: 1200, headChars: 600, tailChars: 200 })
await ctx.plugin(BasicCompactionEngine, {})
const model = new ScriptedModel([])
ctx.llm.registerAdapter(['mock'], model)
ctx.tools.register(lookupRelease)
await ctx.plugin(AgentLoop, { agents: [] })
const { agent } = await ctx.agents.create({ sessionId: sid, agentOptions: { provider: 'mock', model: 'mock' } })

const ask = async (a: Agent, text: string) => {
  const idle = new Promise<void>((resolve) => {
    const off = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === a && status === 'idle') { off(); resolve() }
    })
  })
  a.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
  await ctx.sessions.flush(a.session)
}
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

await ctx.fiber.dispose()
process.exit(0)
