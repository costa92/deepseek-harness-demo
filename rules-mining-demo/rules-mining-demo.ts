/** Mine persisted on-call session logs for failures a rule let through, and let a scripted model propose a candidate rule with evidence. */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { HarnessError, LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as checkpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import PtcRuntimeNode from '@deepseek-ai/dsh-ptc-runtime-node'
import * as RuleStorePlugin from './rule-store.ts'
import { ruleSpecSchema } from './rule-store.ts'
import { findAnomalies, readDeploys, type Anomaly } from './log-miner.ts'

const log = (msg: string) => { console.log(msg) }
const base = mkdtempSync(join(tmpdir(), 'dsh-rules-mining-'))
process.on('exit', () => { rmSync(base, { recursive: true, force: true }) })
const HOUR = 3600_000
let now = Date.UTC(2026, 8, 20, 1)

// ── 脚本化模型：每一轮一组动作；动作能读到本次请求的消息，好从工具结果里取参数 ──────
type Action = (messages: readonly Message[]) => StreamChunk[]
const textOf = (message: Message | undefined) => (message?.content ?? [])
  .map(b => b.type === 'text' ? b.text : b.type === 'tool-result' ? b.content.map(c => c.type === 'text' ? c.text : '').join('') : '')
  .join('')
const isToolResult = (message: Message | undefined) => message?.content.some(b => b.type === 'tool-result') === true
class ScriptedModel extends LlmAdapter {
  readonly turns: Action[][] = []
  private current: Action[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 手动压缩（对照宿主）发来的摘要请求，固定回一段摘要。
    if (options.purpose === 'compaction') {
      for (const chunk of reply('## Summary\n- payment-api 2.3 deploys kept failing')([])) yield chunk
      return
    }
    const last = options.messages.at(-1)
    // 对照宿主挂了沙箱等插件，用户消息后面可能跟着插件消息；按“最近的用户消息之后还没有回复”判断新一轮。
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

// ── 合成发布平台：2.3 每次失败；order-api 超时抛普通 Error，billing-api 抛 HarnessError；结构化结果放进 presentationMeta ──
let metaCalls = 0
const deployRelease = defineTool({
  name: 'deploy_release',
  description: 'Deploy one version of a service to the synthetic release platform.',
  parameters: { service: { type: 'string', required: true }, version: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { service: { type: 'string', required: true }, version: { type: 'string', required: true }, outcome: { type: 'string', required: true }, at: { type: 'number', required: true } } },
    render: (_args, value) => [{ type: 'text', text: `${value.service} ${value.version} ${value.outcome}` }],
    // 会话日志只存 render 出来的文字；想事后按字段挖，就得把字段放进 meta。
    presentationMeta: (_args, value) => { metaCalls++; return { ...value } },
  },
  execute(args) {
    if (args.service === 'order-api') return Promise.reject(new Error('platform timeout'))
    if (args.service === 'billing-api') return Promise.reject(new HarnessError('platform down', 'PLATFORM_DOWN'))
    const version = args.version.replace(/^v/i, '')
    return Promise.resolve({ service: args.service, version, outcome: version === '2.3' ? 'failed' : 'succeeded', at: now })
  },
})

// ── 宿主 ───────────────────────────────────────────────────────────────
const logs = join(base, 'sessions')
const data = join(base, 'data')
interface Host { ctx: Context; model: ScriptedModel }
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
  const model = new ScriptedModel()
  ctx.llm.registerAdapter(['mock'], model)
  ctx.tools.register(deployRelease)
  return { ctx, model }
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

// ── 对照宿主：单独的日志目录；Code Mode、HarnessError、pre-execute deny、fork 与压缩都在这里试 ──
const probeLogs = join(base, 'probe-sessions')
async function bootProbe(): Promise<Host> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'both' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: probeLogs, compression: 'none' })
  await ctx.plugin(checkpointPolicy)
  await ctx.plugin(SqliteSessionQueryEngine, { path: join(base, 'probe-search.db') })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(BasicCompactionEngine)
  await ctx.plugin(LocalSandboxProvider, {})
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: base })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: base })
  await ctx.plugin(PtcRuntimeNode)
  await ctx.plugin(AgentLoop, { agents: [] })
  const model = new ScriptedModel()
  ctx.llm.registerAdapter(['mock'], model)
  ctx.tools.register(deployRelease)
  return { ctx, model }
}
// oxlint-disable-next-line typescript/no-deprecated -- the demo reads the whole log on purpose
const eventsOf = (agent: Agent): readonly SessionEvent[] => agent.session.snapshotEvents()
const dataKeysOf = (e: SessionEvent | undefined) => e?.type === 'tool/result' ? Object.keys(e.data).sort() : []
const callIdOf = (e: SessionEvent | undefined) => e?.type === 'tool/result' ? e.data.message.content.find(b => b.type === 'tool-result')?.toolCallId : undefined

log('== 1. 对照宿主：Code Mode 里的子调用不生成 meta ==')
const probe = await bootProbe()
const probeAgent = await openSession(probe, 'probe')
const metaBefore = metaCalls
await ask(probe, probeAgent, '发布 inventory-api 1.0', deploy('1.0', 'inventory-api'), reply('发好了。'))
const nativeResult = eventsOf(probeAgent).findLast(e => e.type === 'tool/result')!
const nativeMeta = metaCalls - metaBefore
log(`直接调 deploy_release：tool/result data 字段 [${dataKeysOf(nativeResult).join(', ')}]，presentationMeta 执行 ${nativeMeta} 次`)
const metaBeforePtc = metaCalls
const eventsBeforePtc = eventsOf(probeAgent).length
await ask(probe, probeAgent, '用程序发布 inventory-api 1.1',
  call('run_code', { code: "return (await tools.deploy_release({ service: 'inventory-api', version: '1.1' })).outcome", description: 'Deploy one release' }),
  reply('发好了。'))
const ptcEvents = eventsOf(probeAgent).slice(eventsBeforePtc)
const ptcCalls = ptcEvents.flatMap(e => e.type === 'tool/call' ? [e.data.name] : [])
const dispatches = ptcEvents.flatMap(e => e.type === 'tool/ptc-dispatch' ? [e.data] : [])
const runCodeResult = ptcEvents.findLast(e => e.type === 'tool/result')
const ptcMeta = metaCalls - metaBeforePtc
log(`在 run_code 里调 tools.deploy_release：tool/call 只有 ${ptcCalls.join('、')}，子调用记成 ${dispatches.length} 条 tool/ptc-dispatch`)
log(`  tool/ptc-dispatch 字段 [${Object.keys(dispatches[0] ?? {}).sort().join(', ')}]`)
log(`  run_code 的 tool/result data 字段 [${dataKeysOf(runCodeResult).join(', ')}]，presentationMeta 执行 ${ptcMeta} 次`)
assert.deepEqual(dataKeysOf(nativeResult), ['message', 'meta', 'step', 'turn'])
assert.equal(nativeMeta, 1)
assert.deepEqual(ptcCalls, ['run_code'])
assert.equal(dispatches.length, 1)
assert.ok(!Object.keys(dispatches[0] ?? {}).includes('meta'))
assert.ok(!dataKeysOf(runCodeResult).includes('meta'))
assert.equal(ptcMeta, 0)

log('\n== 2. 三天值班：规则每天拦一次，同一版本每天照样失败两次 ==')
{
  const host = await boot(false)
  await store(host).propose({ id: 'same-version-failed', kind: 'failed-in-window', threshold: 2, windowHours: 24 }, '同一版本 24 小时内失败 2 次就拦')
  await store(host).activate('same-version-failed', 1, '上线')
  for (const day of [1, 2, 3]) {
    const agent = await openSession(host, `oncall-day${day}`)
    await ask(host, agent, '发布 payment-api 2.3，失败就重试', deploy('2.3'), deploy('2.3'), deploy('v2.3'), reply('2.3 被规则拦下了。'))
    if (day === 3) await ask(host, agent, '顺便发布 order-api 1.4', deploy('1.4', 'order-api'), reply('order-api 超时了。'))
    log(`第 ${day} 天：规则引擎记下的历史累计 ${store(host).history().length} 条`)
    now += 25 * HOUR
  }
  await store(host).flush()
  await host.ctx.fiber.dispose()
}

log('\n== 3. 换一个宿主，从会话日志里读回部署 ==')
const review = await boot(true)
const records = await readDeploys(review.ctx)
const count = (kind: string) => records.filter(r => r.kind === kind).length
log(`读到 ${records.length} 次 deploy_release：执行 ${count('executed')}，被规则拒绝 ${count('denied')}，其他错误 ${count('error')}`)
const sample = (kind: string) => records.find(r => r.kind === kind)!
for (const kind of ['executed', 'denied', 'error']) {
  const r = sample(kind)
  log(`  ${kind.padEnd(8)} data 字段 [${r.dataKeys.join(', ')}]  文字 "${r.text.slice(0, 44)}"`)
}
log(`  tool/call 里的参数是模型原样给的字符串：${records.filter(r => r.kind === 'denied').map(r => r.rawArguments)[0]}`)
assert.equal(records.length, 10)
assert.deepEqual([count('executed'), count('denied'), count('error')], [6, 3, 1])
assert.deepEqual(sample('denied').dataKeys, sample('error').dataKeys)
assert.ok(!sample('denied').dataKeys.includes('error'))
// 对照宿主：工具抛 HarnessError；pre-execute 用 deny 拒绝并带 info。
const denyOff = probe.ctx.on('tools/pre-execute', async (exec, next) => {
  const args = exec.arguments as { service?: unknown } | undefined
  if (exec.name === 'deploy_release' && args?.service === 'ledger-api') {
    return { kind: 'deny', reason: '[ledger-freeze@1] ledger-api 封版中', info: { name: 'ReleaseRuleDenied', code: 'LEDGER_FREEZE' } }
  }
  return next()
})
await ask(probe, probeAgent, '发布 billing-api 3.0 和 ledger-api 5.0', deploy('3.0', 'billing-api'), deploy('5.0', 'ledger-api'), reply('都没发成。'))
denyOff()
const [harnessResult, denyInfoResult] = eventsOf(probeAgent).filter(e => e.type === 'tool/result').slice(-2)
const errorOf = (e: SessionEvent | undefined) => JSON.stringify(e?.type === 'tool/result' ? e.data.error : undefined)
log(`  对照宿主 抛 HarnessError：data 字段 [${dataKeysOf(harnessResult).join(', ')}]  error ${errorOf(harnessResult)}`)
log(`  对照宿主 deny 带 info：data 字段 [${dataKeysOf(denyInfoResult).join(', ')}]  error ${errorOf(denyInfoResult)}`)
assert.deepEqual(dataKeysOf(harnessResult), ['error', 'message', 'step', 'turn'])
assert.equal(errorOf(harnessResult), '{"name":"HarnessError","code":"PLATFORM_DOWN"}')
assert.deepEqual(dataKeysOf(denyInfoResult), ['error', 'message', 'step', 'turn'])
assert.equal(errorOf(denyInfoResult), '{"name":"ReleaseRuleDenied","code":"LEDGER_FREEZE"}')

log('\n== 4. 找出规则没管住的版本 ==')
const active = store(review).revision('same-version-failed', 1)!.spec
const anomalies = findAnomalies(records, active)
for (const a of anomalies) {
  log(`${a.service} ${a.version}：执行失败 ${a.failures} 次、被拒 ${a.denials} 次，分布在 ${a.sessions} 个会话，首尾相隔 ${a.spanHours} 小时`)
  log(`  当前规则窗口 ${active.windowHours} 小时；证据是这 ${a.evidence.length} 次失败的 tool/result 事件：`)
  for (let i = 0; i < a.evidence.length; i += 3) log(`    ${a.evidence.slice(i, i + 3).join(', ')}`)
}
assert.equal(anomalies.length, 1)
const anomaly = anomalies[0]!
assert.deepEqual([anomaly.failures, anomaly.denials, anomaly.sessions, anomaly.spanHours], [6, 3, 3, 50])
// 证据编号能不能取回原事件：逐条 readEvent，核对 toolCallId。
const callIdByRef = new Map(records.map(r => [r.ref, r.callId]))
const matched: boolean[] = []
for (const ref of anomaly.evidence) {
  const [session = '', seq = ''] = ref.split('#')
  const { target } = await review.ctx.sessionQuery.readEvent({ sessionId: SessionId(session), seq: SessionSeq(Number(seq)) })
  matched.push(callIdOf(target) === callIdByRef.get(ref))
}
log(`readEvent 逐条取回 ${matched.length} 条证据：${matched.filter(Boolean).length} 条是 tool/result，toolCallId 与读回时一致`)
assert.deepEqual(matched, anomaly.evidence.map(() => true))
// 日志被改写：复制一份日志，删掉 oncall-day1 的一行，再用新宿主读。
const tampered = join(base, 'sessions-tampered')
cpSync(logs, tampered, { recursive: true })
const day1File = readdirSync(tampered, { recursive: true, encoding: 'utf8' }).map(f => join(tampered, f)).find(f => f.includes('oncall-day1') && f.endsWith('.jsonl'))!
const lines = readFileSync(day1File, 'utf8').split('\n')
writeFileSync(day1File, [...lines.slice(0, 5), ...lines.slice(6)].join('\n'))
const reader = new Context()
await reader.plugin(SessionStore)
await reader.plugin(SessionProjectionRegistry)
await reader.plugin(JsonlSessionPersistence, { root: tampered, compression: 'none' })
await reader.plugin(SqliteSessionQueryEngine, { path: join(base, 'tampered-search.db') })
const tamperError = await reader.sessionQuery.readSession(SessionId('oncall-day1')).then(() => '读取成功', (error: unknown) => {
  const { code, message } = error as { code?: string; message: string }
  return `${code ?? '-'}: ${/invalid committed event[^(]*\([^)]*\)/.exec(message)?.[0] ?? message}`
})
log(`删掉 oncall-day1 日志第 6 行后 readSession -> ${tamperError}`)
assert.notEqual(tamperError, '读取成功')
await reader.fiber.dispose()
// fork 与压缩之后：对照宿主里那次原生部署的 tool/result 编号还指向它吗。
const nativeSeq = nativeResult.seq
const nativeCallId = callIdOf(nativeResult)
// fork 的写法同第 12 篇：拿父会话的前缀当 seed 新建会话，再在分支里跑一轮，让它落盘。
const forkSeed = eventsOf(probeAgent)
const { agent: forkAgent } = await probe.ctx.agents.create({
  sessionId: SessionId('probe-fork'), seed: forkSeed, inheritedEventCount: SessionLogOffset(forkSeed.length),
  meta: { parentSession: SessionId('probe'), isSeeded: true }, agentOptions: { provider: 'mock', model: 'mock' },
})
await ask(probe, forkAgent, '分支里只做总结', reply('好。'))
const inFork = await probe.ctx.sessionQuery.readEvent({ sessionId: SessionId('probe-fork'), seq: nativeSeq })
const eventsBeforeCompact = eventsOf(probeAgent).length
const compacted = await probe.ctx.compaction.compactNow(probeAgent, new AbortController().signal)
await probe.ctx.sessions.flush(probeAgent.session)
const appended = eventsOf(probeAgent).slice(eventsBeforeCompact).map(e => e.type)
const afterCompact = await probe.ctx.sessionQuery.readEvent({ sessionId: SessionId('probe'), seq: nativeSeq })
const resultsForCall = (await probe.ctx.sessionQuery.readSession(SessionId('probe'))).events.filter(e => callIdOf(e) === nativeCallId).length
const forkRead = await probe.ctx.sessionQuery.readSession(SessionId('probe-fork')).then(() => '读取成功', (error: unknown) => String(error))
const diskReader = new Context()
await diskReader.plugin(SessionStore)
await diskReader.plugin(SessionProjectionRegistry)
await diskReader.plugin(JsonlSessionPersistence, { root: probeLogs, compression: 'none' })
await diskReader.plugin(SqliteSessionQueryEngine, { path: join(base, 'probe-disk-search.db') })
const forkReadFromDisk = await diskReader.sessionQuery.readSession(SessionId('probe-fork')).then(() => '读取成功', (error: unknown) => String(error))
await diskReader.fiber.dispose()
const minerOnProbe = await readDeploys(probe.ctx).then(r => `读到 ${r.length} 次`, (error: unknown) => String(error))
log(`对照宿主 probe#${nativeSeq}（一次原生部署）：fork 出的 probe-fork#${nativeSeq} 是同一次调用 ${callIdOf(inFork.target) === nativeCallId}`)
log(`  手动压缩后日志追加 ${appended.join(', ')}`)
log(`  probe#${nativeSeq} 仍是这次调用 ${callIdOf(afterCompact.target) === nativeCallId}，probe 日志里这次调用的 tool/result 共 ${resultsForCall} 条`)
log(`  readSession(probe-fork) -> ${forkRead}`)
log(`  另起宿主从磁盘读 probe-fork -> ${forkReadFromDisk === forkRead ? '同样报错' : forkReadFromDisk}`)
log(`  对照宿主上跑 readDeploys -> ${minerOnProbe}`)
assert.equal(callIdOf(inFork.target), nativeCallId)
assert.ok(compacted !== null)
assert.equal(callIdOf(afterCompact.target), nativeCallId)
assert.equal(resultsForCall, 1)
assert.equal(forkRead, 'Error: seeded session constructor seed must equal its inherited prefix')
assert.equal(forkReadFromDisk, forkRead)
assert.equal(minerOnProbe, forkRead)

log('\n== 5. 让模型据此提候选规则 ==')
const failedRefs = new Set(records.filter(r => r.kind === 'executed' && r.outcome === 'failed').map(r => r.ref))
review.ctx.tools.register(defineTool({
  name: 'list_anomalies',
  description: 'List releases that kept failing although a rule was active, with evidence refs into session logs.',
  parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: () => Promise.resolve(JSON.stringify(anomalies)),
}))
review.ctx.tools.register(defineTool({
  name: 'propose_rule',
  description: 'Propose a new revision of a release rule. It is stored as a candidate and not enforced until approved.',
  parameters: {
    spec: { type: 'object', additionalProperties: true, required: true },
    evidence: { type: 'array', items: { type: 'string' }, required: true },
    note: { type: 'string', required: true },
  },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute(args) {
    const parsed = ruleSpecSchema.safeParse(args.spec)
    if (!parsed.success) throw new Error(`规则不合法：${parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`)
    // 证据必须指向日志里真实存在、确实执行失败的部署，模型给的编号不能直接信。
    const bad = args.evidence.filter(ref => !failedRefs.has(ref))
    if (bad.length > 0) throw new Error(`证据不成立：${bad.join(', ')} 不是一次执行失败的部署`)
    const revision = await review.ctx.get('ruleStore')!.propose(parsed.data, args.note, args.evidence)
    return `已保存为候选 ${parsed.data.id}@${revision}，未生效`
  },
}))
const firstAnomaly = (toolText: string) => (JSON.parse(toolText) as Anomaly[])[0]!
let evidence: string[] = []
const reviewer = await openSession(review, 'rule-review')
await ask(review, reviewer, '看看有没有规则没管住的发布，提一条候选规则',
  call('list_anomalies', {}),
  call('propose_rule', (text) => {
    evidence = firstAnomaly(text).evidence
    return { spec: { id: 'same-version-failed', kind: 'failed-in-window', threshold: 2, windowHours: '7d' }, evidence, note: '窗口放宽到 7 天' }
  }),
  call('propose_rule', { spec: { id: 'same-version-failed', kind: 'failed-in-window', threshold: 2, windowHours: 168 }, evidence: ['oncall-day1#3', 'oncall-day9#12'], note: '窗口放宽到 7 天' }),
  call('propose_rule', () => ({ spec: { id: 'same-version-failed', kind: 'failed-in-window', threshold: 2, windowHours: 168 }, evidence, note: '窗口放宽到 7 天' })),
  reply('已提交候选规则，等评测和人工确认。'),
)
const reviewLog = (await review.ctx.sessionQuery.readSession(SessionId('rule-review'))).events
const proposals = reviewLog.flatMap(e => e.type === 'tool/result' ? e.data.message.content.flatMap(b => b.type === 'tool-result' ? [b] : []) : [])
  .slice(1).map(b => `${b.isError === true ? '拒绝' : '通过'} ${b.content.map(c => c.type === 'text' ? c.text : '').join('')}`)
proposals.forEach((line, i) => { log(`提交 ${i + 1}：${line}`) })
assert.equal(proposals.length, 3)
assert.match(proposals[0]!, /^拒绝 Error: 规则不合法：windowHours/)
assert.match(proposals[1]!, /^拒绝 Error: 证据不成立/)
assert.match(proposals[2]!, /^通过 已保存为候选 same-version-failed@2/)

log('\n== 6. 候选只是存下来，还没生效 ==')
const candidate = store(review).revision('same-version-failed', 2)!
log(`版本 ${store(review).revisions('same-version-failed').join(', ')}；生效 ${store(review).active().join(', ')}；候选 ${store(review).candidates('same-version-failed').join(', ')}`)
log(`候选第 2 版：窗口 ${candidate.spec.windowHours} 小时，附 ${candidate.evidence?.length ?? 0} 条证据`)
const day4 = await review.ctx.tools.execute({
  callId: ToolCallId('day4'), name: 'deploy_release',
  arguments: { service: 'payment-api', version: '2.3' }, signal: new AbortController().signal,
})
log(`第 4 天 deploy(2.3) -> ${day4.isError ? `拒绝 ${day4.error.message}` : `执行 ${(day4.value as { outcome: string }).outcome}`}（生效的仍是第 1 版）`)
// 试算：把指针临时指向第 2 版，同一天再部署一次，然后改回第 1 版。
await store(review).activate('same-version-failed', 2, '试算第 2 版')
const day4v2 = await review.ctx.tools.execute({
  callId: ToolCallId('day4-v2'), name: 'deploy_release',
  arguments: { service: 'payment-api', version: '2.3' }, signal: new AbortController().signal,
})
await store(review).activate('same-version-failed', 1, '改回第 1 版')
log(`试算：指针临时指向第 2 版，同一天再部署 2.3 -> ${day4v2.isError ? `拒绝 ${day4v2.error.message}` : '执行'}`)
assert.deepEqual(store(review).candidates('same-version-failed'), [2])
assert.deepEqual(candidate.evidence, anomaly.evidence)
assert.equal(day4.isError, false)
assert.match(day4v2.isError ? day4v2.error.message : '', /^\[same-version-failed@2\] payment-api 2\.3 在 168 小时内已失败 7 次/)
await store(review).flush()
await review.ctx.fiber.dispose()
await probe.ctx.fiber.dispose()
