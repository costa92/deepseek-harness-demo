/** Evaluate candidate rules by replaying logged deploys, gate activation behind dsh's approval path, and read the rule's lineage back. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as checkpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ApprovalService, { setApprovalPolicy, type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as RuleStorePlugin from './rule-store.ts'
import { ruleSpecSchema, type RuleSpec } from './rule-store.ts'
import { readDeploys } from './log-miner.ts'
import * as Activation from './evaluate.ts'
import { datasetId, replay } from './evaluate.ts'

const log = (msg: string) => { console.log(msg) }
const base = mkdtempSync(join(tmpdir(), 'dsh-rules-review-'))
process.on('exit', () => { rmSync(base, { recursive: true, force: true }) })
const HOUR = 3600_000
let now = Date.UTC(2026, 8, 20, 1)
const day2 = now + 25 * HOUR

// ── 脚本化模型：每一轮一组动作；动作能读到本次请求的消息，好从工具结果里取参数 ──────
type Action = (messages: readonly Message[]) => StreamChunk[]
const textOf = (message: Message | undefined) => (message?.content ?? [])
  .map(b => b.type === 'text' ? b.text : b.type === 'tool-result' ? b.content.map(c => c.type === 'text' ? c.text : '').join('') : '')
  .join('')
class ScriptedModel extends LlmAdapter {
  readonly turns: Action[][] = []
  private current: Action[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages.at(-1)
    // agent 循环会把系统提示里的运行时上下文（这里是审批策略）作为插件来源的用户消息追加在用户消息后面，
    // 所以按“最近的用户消息之后还没有回复”判断新一轮。
    const lastUser = options.messages.findLastIndex(m => m.role === 'user' && m.source.kind === 'user')
    if (!options.messages.slice(lastUser + 1).some(m => m.role === 'assistant')) this.current = this.turns.shift() ?? []
    const action = this.current.shift()
    assert.ok(action, `the scripted model has no action for: ${textOf(last).slice(0, 60)}`)
    for (const chunk of action(options.messages)) yield chunk
  }
}
const reply = (text: string): Action => () => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
  { type: 'finish', reason: { kind: 'stop' } },
]
let callSeq = 0
const call = (name: string, args: object | ((lastToolText: string) => object)): Action => (messages) => {
  const id = ToolCallId(`call-${++callSeq}`)
  const json = JSON.stringify(typeof args === 'function' ? args(textOf(messages.at(-1))) : args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

// ── 合成发布平台：2.3 每次失败；2.5 第 1 天失败、之后成功（平台抖动）；结构化结果放进 presentationMeta ──
const deployRelease = defineTool({
  name: 'deploy_release',
  description: 'Deploy one version of a service to the synthetic release platform.',
  parameters: { service: { type: 'string', required: true }, version: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { service: { type: 'string', required: true }, version: { type: 'string', required: true }, outcome: { type: 'string', required: true }, at: { type: 'number', required: true } } },
    render: (_args, value) => [{ type: 'text', text: `${value.service} ${value.version} ${value.outcome}` }],
    // 会话日志只存 render 出来的文字；想事后按字段挖，就得把字段放进 meta。
    presentationMeta: (_args, value) => ({ ...value }),
  },
  execute(args) {
    const version = args.version.replace(/^v/i, '')
    const failed = version === '2.3' || (version === '2.5' && now < day2)
    return Promise.resolve({ service: args.service, version, outcome: failed ? 'failed' : 'succeeded', at: now })
  },
})

// ── 宿主 ───────────────────────────────────────────────────────────────
const logs = join(base, 'sessions')
const data = join(base, 'data')
interface Host { ctx: Context; model: ScriptedModel; approval: ReturnType<Context['plugin']> }
async function boot(withQuery: boolean): Promise<Host> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: logs, compression: 'none' })
  await ctx.plugin(checkpointPolicy)
  if (withQuery) await ctx.plugin(SqliteSessionQueryEngine, { path: join(base, 'session-search.db') })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: data })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(RuleStorePlugin, { now: () => now })
  await ctx.plugin(AgentLoop, { agents: [] })
  const approval = ctx.plugin(ApprovalService, { policy: 'ask' })
  await approval
  const model = new ScriptedModel()
  ctx.llm.registerAdapter(['mock'], model)
  ctx.tools.register(deployRelease)
  return { ctx, model, approval }
}
const store = (host: Host) => host.ctx.get('ruleStore')!
async function ask(host: Host, agent: Agent, text: string, ...actions: Action[]): Promise<void> {
  host.model.turns.push(actions)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await host.ctx.sessions.flush(agent.session)
  assert.equal(host.model.turns.length, 0)
}
const openSession = async (host: Host, id: string) =>
  (await host.ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'mock', model: 'mock' } })).agent
const deploy = (version: string, service = 'payment-api') => call('deploy_release', { service, version })

const rule = (windowHours: number, threshold: number): RuleSpec => ({ id: 'same-version-failed', kind: 'failed-in-window', threshold, windowHours })
const toolText = (b: { content: readonly { type: string; text?: string }[] }) => b.content.map(c => c.type === 'text' ? c.text ?? '' : '').join('')

log('== 1. 数据：三天值班，2.3 每天失败，2.5 第 1 天失败两次、第 2 天成功 ==')
{
  const host = await boot(false)
  await store(host).propose(rule(24, 2), '人工录入：同一版本 24 小时内失败 2 次就拦')
  await store(host).activate('same-version-failed', 1, '上线')
  for (const day of [1, 2, 3]) {
    const agent = await openSession(host, `oncall-day${day}`)
    const extra = day === 1 ? [deploy('2.5'), deploy('2.5')] : day === 2 ? [deploy('2.5')] : []
    await ask(host, agent, '发布 payment-api 2.3 和 2.5，失败就重试', deploy('2.3'), deploy('2.3'), deploy('v2.3'), ...extra, reply('发完了。'))
    now += 25 * HOUR
  }
  await store(host).flush()
  await host.ctx.fiber.dispose()
}
const review = await boot(true)
const records = await readDeploys(review.ctx)
const dataset = datasetId(records)
const executed = records.filter(r => r.kind === 'executed')
log(`数据集 ${dataset}：${records.length} 次调用，执行 ${executed.length} 次（失败 ${executed.filter(r => r.outcome === 'failed').length}、成功 ${executed.filter(r => r.outcome === 'succeeded').length}），被规则拒绝 ${records.filter(r => r.kind === 'denied').length} 次`)
const failedRefs = executed.filter(r => r.outcome === 'failed' && r.version === '2.3').map(r => r.ref)
await store(review).propose(rule(168, 2), '第 23 篇的候选：窗口放宽到 7 天', failedRefs)
assert.equal(dataset.split('-')[0], '12')
assert.equal(executed.length, 9)

log('\n== 2. 回放评测：同一份数据集，三个版本的规则 ==')
const table = [rule(24, 2), rule(168, 2), rule(168, 3)].map((spec) => {
  const r = replay(records, spec)
  log(`${String(spec.windowHours).padStart(3)} 小时内失败 ${spec.threshold} 次：少失败 ${r.prevented} 次，误拦成功 ${r.falseBlocks} 次`)
  return [r.prevented, r.falseBlocks]
})
assert.deepEqual(table, [[0, 0], [4, 1], [3, 0]])

log('\n== 3. 启用走 dsh 的审批：pre-execute 返回 ask ==')
const seen: string[] = []
/** Scripted answers for step 6; empty means the reviewer decides from the reason. */
const overrides: (() => Promise<ApprovalOutcome>)[] = []
let answered = 0
review.ctx.on('approval/request', (req) => {
  answered++
  const override = overrides.shift()
  if (override !== undefined) return override()
  // 脚本化的审批人：请求里不带参数，要看参数得按 callId 回发起方的会话日志找；回放里有误拦就拒绝。
  seen.push(`应答者收到 [${Object.keys(req).sort().join(', ')}]`)
  // oxlint-disable-next-line typescript/no-deprecated -- the answerer reads the asking agent's log on purpose
  const call = req.agent.session.snapshotEvents().find(e => e.type === 'tool/call' && e.data.callId === req.callId)
  seen.push(`  按 callId 回会话日志查到参数：${call?.type === 'tool/call' ? call.data.arguments : '-'}`)
  seen.push(`  reason：${req.reason ?? '-'}`)
  const outcome: ApprovalOutcome = req.reason?.includes('误拦成功 0 次') === true ? 'allowed-once' : 'rejected'
  seen.push(`  决定：${outcome}`)
  return Promise.resolve(outcome)
})
await review.ctx.plugin(Activation, { records, now: () => now })
review.ctx.tools.register(defineTool({
  name: 'propose_rule',
  description: 'Propose a new revision of a release rule; stored as a candidate, not enforced.',
  parameters: {
    spec: { type: 'object', additionalProperties: true, required: true },
    evidence: { type: 'array', items: { type: 'string' }, required: true },
    note: { type: 'string', required: true },
  },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute(args) {
    const spec = ruleSpecSchema.parse(args.spec)
    const known = new Set(records.map(r => r.ref))
    const bad = args.evidence.filter(ref => !known.has(ref))
    if (bad.length > 0) throw new Error(`证据不成立：${bad.join(', ')}`)
    const revision = await review.ctx.get('ruleStore')!.propose(spec, args.note, args.evidence)
    return `已保存为候选 ${spec.id}@${revision}，未生效`
  },
}))
const reviewer = await openSession(review, 'rule-review')
await ask(review, reviewer, '评审候选规则，合适就申请启用',
  call('activate_rule', { ruleId: 'same-version-failed', revision: 2 }),
  call('propose_rule', { spec: rule(168, 3), evidence: failedRefs, note: '阈值提到 3 次，避免误拦平台抖动' }),
  call('activate_rule', { ruleId: 'same-version-failed', revision: 3 }),
  reply('第 3 版已启用。'),
)
seen.forEach((line) => { log(line) })
const reviewEvents = (await review.ctx.sessionQuery.readSession(SessionId('rule-review'))).events
const results = reviewEvents.flatMap(e => e.type === 'tool/result' ? e.data.message.content.flatMap(b => b.type === 'tool-result' ? [b] : []) : [])
results.forEach((b, i) => { log(`工具结果 ${i + 1}：${b.isError === true ? '失败' : '成功'} ${toolText(b)}`) })
assert.equal(seen.filter(l => l.startsWith('应答者')).length, 2)
assert.ok(seen[0]!.includes('[agent, callId, reason, signal, toolName]'))
assert.ok(seen[1]!.endsWith('{"ruleId":"same-version-failed","revision":2}'))
assert.deepEqual(results.map(b => b.isError === true), [true, false, false])
assert.deepEqual(store(review).active(), ['same-version-failed@3'])

log('\n== 4. 规则的谱系：版本表、评测表和会话日志拼起来 ==')
const approvals = new Map<string, { asked: string; outcome: string }>()
const asked = new Map<string, string>()
const decidedKeys = new Set<string>()
for (const e of reviewEvents) {
  if (e.type === 'approval/asked' && e.data.callId !== undefined) asked.set(e.data.id, `rule-review#${e.data.callId}|rule-review#${e.seq}`)
  if (e.type === 'approval/decided') {
    decidedKeys.add(Object.keys(e.data).sort().join(', '))
    const [callId = '', ref = ''] = (asked.get(e.data.id) ?? '').split('|')
    approvals.set(callId, { asked: ref, outcome: e.data.outcome })
  }
}
const evaluations = store(review).evaluations()
for (const revision of store(review).revisions('same-version-failed')) {
  const rev = store(review).revision('same-version-failed', revision)!
  log(`@${revision} ${rev.spec.windowHours} 小时/${rev.spec.threshold} 次：${rev.note}；证据 ${rev.evidence?.length ?? 0} 条`)
  for (const [callId, ev] of evaluations.filter(([, ev]) => ev.revision === revision)) {
    const decision = approvals.get(callId)
    log(`   评测 ${callId}：少失败 ${ev.prevented}、误拦 ${ev.falseBlocks}；审批 ${decision?.asked ?? '-'} -> ${decision?.outcome ?? '-'}`)
  }
}
log(`当前生效：${store(review).active().join(', ')}`)
log(`日志里 approval/decided 的字段：[${[...decidedKeys].join(' | ')}]`)
assert.equal(evaluations.length, 2)
assert.deepEqual([...decidedKeys], ['id, outcome'])
assert.deepEqual([...approvals.values()].map(a => a.outcome), ['rejected', 'allowed-once'])

log('\n== 5. 生效之后：第 4 天再部署 ==')
const direct = async (name: string, args: object) => {
  const result = await review.ctx.tools.execute({
    callId: ToolCallId(`direct-${name}-${JSON.stringify(args)}`), name, arguments: args, signal: new AbortController().signal,
  })
  return result.isError ? `拒绝 ${result.error.message}` : `执行 ${JSON.stringify(result.value)}`
}
const d23 = await direct('deploy_release', { service: 'payment-api', version: '2.3' })
const d25 = await direct('deploy_release', { service: 'payment-api', version: '2.5' })
log(`deploy(2.3) -> ${d23.replace(/,"at":\d+/, '')}`)
log(`deploy(2.5) -> ${d25.replace(/,"at":\d+/, '')}`)
assert.match(d23, /^拒绝 \[same-version-failed@3\]/)
assert.match(d25, /"outcome":"succeeded"/)

log('\n== 6. 审批服务在场：应答者的几种结果、never 策略、前置 allow ==')
const probeAgent = await openSession(review, 'rule-review-probe')
const lastResultOf = (agent: Agent) => {
  // oxlint-disable-next-line typescript/no-deprecated -- the demo reads the whole log on purpose
  const block = agent.session.snapshotEvents().flatMap(e => e.type === 'tool/result' ? e.data.message.content.flatMap(b => b.type === 'tool-result' ? [b] : []) : []).at(-1)!
  return `${block.isError === true ? '失败' : '成功'} ${toolText(block)}`
}
const askedCounts: number[] = []
const tryActivate = async (label: string, revision: number) => {
  const before = answered
  await ask(review, probeAgent, `申请启用第 ${revision} 版`, call('activate_rule', { ruleId: 'same-version-failed', revision }), reply('好。'))
  const line = lastResultOf(probeAgent)
  askedCounts.push(answered - before)
  log(`${label} -> ${line}（问了应答者 ${answered - before} 次）`)
  return line
}
const outcomeCases: [string, () => Promise<ApprovalOutcome>][] = [
  ['应答者返回 cancelled', () => Promise.resolve('cancelled')],
  ['应答者返回 unavailable', () => Promise.resolve('unavailable')],
  ['应答者抛错', () => Promise.reject(new Error('审批后台挂了'))],
  ["应答者返回未知值 'maybe'", () => Promise.resolve('maybe' as ApprovalOutcome)],
]
const outcomeLines: string[] = []
for (const [label, answer] of outcomeCases) {
  overrides.push(answer)
  outcomeLines.push(await tryActivate(label, 1))
}
setApprovalPolicy(probeAgent.session, 'never')
const neverLine = await tryActivate('会话策略改成 never', 1)
setApprovalPolicy(probeAgent.session, 'ask')
const evaluationsBefore = store(review).evaluations().length
const allowAll = review.ctx.on('tools/pre-execute', () => Promise.resolve<PreToolDecision>({ kind: 'allow' }), true)
const allowLine = await tryActivate('最外层再挂一个直接 allow 的监听器', 3)
allowAll()
log(`  评测表条数没变：${store(review).evaluations().length === evaluationsBefore}`)
assert.deepEqual(outcomeLines, [
  '失败 Error: approval for tool "activate_rule" was cancelled',
  '失败 Error: tool "activate_rule" requires approval, but no approval channel is available',
  '失败 Error: tool "activate_rule" requires approval, but no approval channel is available',
  '失败 Error: tool "activate_rule" requires approval, but no approval channel is available',
])
assert.equal(neverLine, '失败 Error: the user rejected tool "activate_rule"')
assert.equal(allowLine, '成功 已启用 same-version-failed@3')
assert.deepEqual(askedCounts, [1, 1, 1, 1, 0, 0])
assert.equal(store(review).evaluations().length, evaluationsBefore)
assert.deepEqual(store(review).active(), ['same-version-failed@3'])

log('\n== 7. 审批不在场 ==')
log('不经过 agent 直接调 activate_rule：')
log(`  ${await direct('activate_rule', { ruleId: 'same-version-failed', revision: 1 })}`)
await review.approval.dispose()
const noApproval = await openSession(review, 'rule-review-2')
await ask(review, noApproval, '回滚到第 1 版', call('activate_rule', { ruleId: 'same-version-failed', revision: 1 }), reply('没有启用成功。'))
const last = (await review.ctx.sessionQuery.readSession(SessionId('rule-review-2'))).events
  .flatMap(e => e.type === 'tool/result' ? e.data.message.content.flatMap(b => b.type === 'tool-result' ? [b] : []) : [])[0]!
log('卸掉审批服务后经 agent 调 activate_rule，模型收到：')
log(`  ${toolText(last)}`)
log(`生效仍是：${store(review).active().join(', ')}`)
assert.deepEqual(store(review).active(), ['same-version-failed@3'])
assert.equal(last.isError, true)
await store(review).flush()
await review.ctx.fiber.dispose()
