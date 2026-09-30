/** Persist release rules in storage-domain: restart, edit, roll back, and probe what the storage layer does not promise. */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as RuleStorePlugin from './rule-store.ts'
import { rulesDomain, type Config } from './rule-store.ts'

const log = (msg: string) => { console.log(msg) }
const base = mkdtempSync(join(tmpdir(), 'dsh-rules-store-'))
process.on('exit', () => { rmSync(base, { recursive: true, force: true }) })
let dirs = 0
const freshRoot = () => join(base, `root${++dirs}`)

// ── 合成发布平台：2.3 每次都失败，接受 v 前缀 ───────────────────────────
let platformRuns = 0
const deployRelease = defineTool({
  name: 'deploy_release',
  description: 'Deploy one version of a service to the synthetic release platform.',
  parameters: { service: { type: 'string', required: true }, version: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { service: { type: 'string', required: true }, version: { type: 'string', required: true }, outcome: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: `${value.service} ${value.version} ${value.outcome}` }],
  },
  execute(args) {
    platformRuns++
    const version = args.version.replace(/^v/i, '')
    return Promise.resolve({ service: args.service, version, outcome: version === '2.3' ? 'failed' : 'succeeded' })
  },
})

// ── 脚本化模型：每次请求取下一条预先写好的回复（第 3 步的 agent 循环用）──────
class ScriptedModel extends LlmAdapter {
  readonly replies: StreamChunk[][] = []
  /** Simulated time each model request takes before it streams. */
  latencyMs = 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const next = this.replies.shift()
    assert.ok(next, 'the scripted model ran out of replies')
    if (this.latencyMs > 0) await new Promise(resolve => setTimeout(resolve, this.latencyMs))
    for (const chunk of next) yield chunk
  }
}
let modelCalls = 0
/** One assistant message carrying every listed deploy call. */
const deployCalls = (...versions: string[]): StreamChunk[] => [
  ...versions.flatMap((version, index): StreamChunk[] => {
    const id = ToolCallId(`model-call-${++modelCalls}`)
    const json = JSON.stringify({ service: 'payment-api', version })
    return [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name: 'deploy_release', argumentsDelta: json },
      { type: 'block-end', index, block: { type: 'tool-call', id, name: 'deploy_release', arguments: json } },
    ]
  }),
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]
const done: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '好了。' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '好了。' } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

// ── 宿主：工具运行时 + 存储三件套 + 规则存储插件 ──────────────────────────
interface Host { ctx: Context; failure?: string }
async function boot(root: string, config: Config = {}, withAgent = false): Promise<Host> {
  const ctx = new Context()
  if (withAgent) {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
  }
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  ctx.tools.register(deployRelease)
  if (withAgent) {
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
  }
  // 规则插件起不来时，宿主其余部分照常运行；这里记下原因，不让它中断脚本。
  const failure = await ctx.plugin(RuleStorePlugin, config).then(() => undefined, (error: unknown) => {
    const { code, detail } = error as { code?: string; detail?: { table: string; key: string } }
    return `${code}，${detail?.table}/${detail?.key} 不符合 schema`
  })
  return failure === undefined ? { ctx } : { ctx, failure }
}
const store = (host: Host) => host.ctx.get('ruleStore')
let calls = 0
async function deploy(host: Host, version: string): Promise<string> {
  const result = await host.ctx.tools.execute({
    callId: ToolCallId(`call-${++calls}`), name: 'deploy_release',
    arguments: { service: 'payment-api', version }, signal: new AbortController().signal,
  })
  return result.isError ? `拒绝 ${result.error.message}` : `执行 ${(result.value as { outcome: string }).outcome}`
}
const rule = (threshold: unknown) => ({ id: 'same-version-failed', kind: 'failed-in-window', threshold, windowHours: 24 })

log('== 1. 规则和历史存进 storage-domain，重启后还在 ==')
const root1 = freshRoot()
const a = await boot(root1)
await store(a)!.propose(rule(2), '同一版本 24 小时内失败 2 次就拦')
await store(a)!.activate('same-version-failed', 1, '上线')
const firstRun = [await deploy(a, '2.3'), await deploy(a, '2.3'), await deploy(a, '2.3')]
firstRun.forEach((line, i) => { log(`第 ${i + 1} 次 deploy(2.3) -> ${line}`) })
await store(a)!.flush()
await a.ctx.fiber.dispose()
const onDisk = JSON.parse(readFileSync(join(root1, 'release_rules.json'), 'utf8')) as { tables: Record<string, object> }
log(`磁盘上：${readdirSync(root1).join(', ')}，${Object.entries(onDisk.tables).map(([t, r]) => `${t} ${Object.keys(r).length} 条`).join('，')}`)
const b = await boot(root1)
log(`重启后：生效规则 ${store(b)!.active().join(', ')}，历史 ${store(b)!.history().length} 条`)
log(`重启后 deploy(2.3) -> ${await deploy(b, '2.3')}`)
log(`平台共执行 ${platformRuns} 次`)
assert.deepEqual(firstRun.map(l => l.slice(0, 2)), ['执行', '执行', '拒绝'])
assert.equal(platformRuns, 2)
assert.equal(store(b)!.history().length, 2)
assert.match(await deploy(b, 'v2.3'), /^拒绝 \[same-version-failed@1\]/)

log('\n== 2. 修改规则、回滚 ==')
await store(b)!.propose(rule(4), '放宽到 4 次')
await store(b)!.activate('same-version-failed', 2, '改用第 2 版')
log(`改用第 2 版后 deploy(2.3) -> ${await deploy(b, '2.3')}`)
await store(b)!.activate('same-version-failed', 1, '回滚到第 1 版')
log(`回滚后：版本 ${store(b)!.revisions('same-version-failed').join(', ')}，生效 ${store(b)!.active().join(', ')}`)
const rolledBack = await deploy(b, '2.3')
log(`回滚后 deploy(2.3) -> ${rolledBack}`)
assert.equal(platformRuns, 3)
assert.match(rolledBack, /^拒绝 \[same-version-failed@1\]/)
assert.deepEqual(store(b)!.revisions('same-version-failed'), [1, 2])
await store(b)!.flush()
await b.ctx.fiber.dispose()

log('\n== 3. 工具刚返回，这次结果还读不到 ==')
for (const countPending of [false, true]) {
  const host = await boot(freshRoot(), { countPending })
  await store(host)!.propose(rule(2), '同上')
  await store(host)!.activate('same-version-failed', 1, '上线')
  const before: number = platformRuns
  const seen: number[] = []
  const outcomes: string[] = []
  for (let i = 0; i < 3; i++) {
    outcomes.push((await deploy(host, '2.3')).slice(0, 2))
    seen.push(store(host)!.history().length)
  }
  log(`countPending=${countPending}：三次结果 ${outcomes.join('/')}，每次返回后规则看到的历史 ${seen.join('/')}，平台执行 ${platformRuns - before} 次`)
  assert.equal(platformRuns - before, countPending ? 2 : 3)
  await store(host)!.flush()
  await host.ctx.fiber.dispose()
}
// 换成真实的 agent 循环：三次部署放在同一条模型回复里，或分成三轮回复。
async function agentRun(countPending: boolean, oneReply: boolean, latencyMs: number): Promise<string> {
  const host = await boot(freshRoot(), { countPending }, true)
  const model = new ScriptedModel()
  model.latencyMs = latencyMs
  host.ctx.llm.registerAdapter(['mock'], model)
  await store(host)!.propose(rule(2), '同上')
  await store(host)!.activate('same-version-failed', 1, '上线')
  model.replies.push(...oneReply
    ? [deployCalls('2.3', '2.3', '2.3'), done]
    : [deployCalls('2.3'), deployCalls('2.3'), deployCalls('2.3'), done])
  const { agent } = await host.ctx.agents.create({ sessionId: SessionId('oncall'), agentOptions: { provider: 'mock', model: 'mock' } })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '把 payment-api 2.3 发上去，失败就重试' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  assert.equal(model.replies.length, 0)
  const outcomes = toolResults(agent).map(isError => isError ? '拒绝' : '执行')
  await store(host)!.flush()
  await host.ctx.fiber.dispose()
  return outcomes.join('/')
}
// oxlint-disable-next-line typescript/no-deprecated -- the demo reads the whole log on purpose
const toolResults = (agent: Agent) => agent.session.snapshotEvents().flatMap((e: SessionEvent) => e.type === 'tool/result'
  ? e.data.message.content.flatMap(b => b.type === 'tool-result' ? [b.isError === true] : [])
  : [])
const loopRuns: [string, string][] = []
const loopCases = [[false, true, 200], [false, false, 0], [false, false, 200], [true, true, 0]] as const
for (const [countPending, oneReply, latencyMs] of loopCases) {
  const label = `agent 循环 countPending=${countPending}，${oneReply ? '同一条回复连发 3 次' : '分 3 轮各发 1 次'}，模型请求耗时 ${latencyMs}ms`
  loopRuns.push([label, await agentRun(countPending, oneReply, latencyMs)])
}
for (const [label, outcomes] of loopRuns) log(`${label}：${outcomes}`)
assert.deepEqual(loopRuns.map(([, o]) => o), ['执行/执行/执行', '执行/执行/执行', '执行/执行/拒绝', '执行/执行/拒绝'])

log('\n== 4. 关宿主时还在排队的写入 ==')
const root4 = freshRoot()
const c = await boot(root4)
await store(c)!.propose(rule(2), '同上')
await store(c)!.activate('same-version-failed', 1, '上线')
await deploy(c, '2.3')
await deploy(c, '2.3')
await deploy(c, '2.4')
const lost = store(c)!
await c.ctx.fiber.dispose()
log(`不 flush 直接关：写入失败 ${lost.writeErrors.length} 条，${lost.writeErrors[0] ?? '-'}`)
const d = await boot(root4)
const landed = store(d)!.history().length
log(`重启后历史 ${landed} 条；deploy(2.3) -> ${await deploy(d, '2.3')}`)
assert.equal(lost.writeErrors.length, 2)
assert.equal(landed, 1)
// 对照：监听器不自己接住失败，直接返回 rejected promise。
const warnings: string[] = []
d.ctx.logger.exporter({ levels: { default: 3 }, export: (m) => { if (m.type === 'warn') warnings.push(String(m.args[0])) } })
const disposeRejecting = d.ctx.on('tools/result', () => Promise.reject(new Error('unit closed')))
const withRejecting = await deploy(d, '2.4')
await new Promise(resolve => setTimeout(resolve, 10))
disposeRejecting()
log(`监听器直接返回 rejected promise：deploy(2.4) -> ${withRejecting}；dsh 只记 ${warnings.length} 条 warn：${warnings[0] ?? '-'}`)
assert.equal(withRejecting, '执行 succeeded')
assert.deepEqual(warnings, ['tool "deploy_release" (call-' + calls + '): tools/result observer failed: unit closed'])
await store(d)!.flush()
await d.ctx.fiber.dispose()

log('\n== 5. 模型生成的规则不校验就写进去 ==')
const checked = await boot(freshRoot())
const rejected = await store(checked)!.propose(rule('2'), '模型给的阈值是字符串').then(() => 'accepted', (error: unknown) => {
  const issues = (error as { issues?: { path: unknown[]; message: string }[] }).issues ?? []
  return issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
})
log(`先校验：propose 被拒 -> ${rejected}`)
assert.match(rejected, /^threshold:/)
await checked.ctx.fiber.dispose()
const root5 = freshRoot()
const trusting = await boot(root5, { trustProposals: true })
await store(trusting)!.propose(rule('2'), '模型给的阈值是字符串')
await store(trusting)!.activate('same-version-failed', 1, '上线')
const trustedRun = [await deploy(trusting, '2.3'), await deploy(trusting, '2.3'), await deploy(trusting, '2.3')]
log(`不校验：写入成功，本进程里三次 -> ${trustedRun.map(l => l.slice(0, 2)).join('/')}`)
await store(trusting)!.flush()
await trusting.ctx.fiber.dispose()
const reopened = await boot(root5)
log(`重启：规则存储没起来 -> ${reopened.failure}`)
const before5 = platformRuns
log(`ctx.ruleStore 存在吗：${store(reopened) !== undefined}；deploy(2.3) -> ${await deploy(reopened, '2.3')}，平台执行 ${platformRuns - before5} 次`)
assert.equal(trustedRun[2]?.slice(0, 2), '拒绝')
assert.equal(reopened.failure, 'invalid-record，revisions/same-version-failed_1 不符合 schema')
assert.equal(platformRuns - before5, 1)
await reopened.ctx.fiber.dispose()

log('\n== 6. per-record + backup-and-skip：坏记录挪走，其余照常 ==')
const root6s = freshRoot()
const singleSkip = rulesDomain({ invalidRecords: 'backup-and-skip' })
const s1 = await boot(root6s, { trustProposals: true, domain: singleSkip })
await store(s1)!.propose(rule('2'), '模型给的阈值是字符串')
await s1.ctx.fiber.dispose()
const s2 = await boot(root6s, { domain: singleSkip })
log(`single + backup-and-skip 重启 -> ${s2.failure ?? '成功'}`)
assert.equal(s2.failure, 'invalid-record，revisions/same-version-failed_1 不符合 schema')
await s2.ctx.fiber.dispose()
const root6 = freshRoot()
const skipDomain = rulesDomain({ layout: 'per-record', invalidRecords: 'backup-and-skip' })
const e = await boot(root6, { trustProposals: true, domain: skipDomain })
const keyError = await e.ctx.storageDomain.get('release_rules')!.table('revisions')
  .put('same-version-failed@1', { spec: rule(2), note: '', at: 0 }).then(() => 'ok', (error: unknown) => String(error).replace(/^Error: unit 'release_rules': /, '').replace(/ \(must.*$/, ''))
log(`per-record 下写入带 @ 的键 -> ${keyError}`)
assert.match(keyError, /is not path-safe/)
await store(e)!.propose(rule('2'), '模型给的阈值是字符串')
await store(e)!.activate('same-version-failed', 1, '上线')
await deploy(e, '2.3')
await store(e)!.flush()
await e.ctx.fiber.dispose()
const f = await boot(root6, { domain: skipDomain })
const revisionFiles = readdirSync(join(root6, 'release_rules', 'revisions')).map(n => n.replace(/\.bak\.[\w-]+$/, '.bak.<时间>'))
log(`重启成功；revisions 目录：${revisionFiles.join(', ')}`)
log(`生效指针还在：${store(f)!.active().join(', ')}，历史 ${store(f)!.history().length} 条`)
log(`deploy(2.4) -> ${await deploy(f, '2.4')}`)
assert.equal(f.failure, undefined)
assert.deepEqual(revisionFiles, ['same-version-failed_1.json.bak.<时间>'])
assert.match(await deploy(f, '2.4'), /规则版本缺失/)
await f.ctx.fiber.dispose()

log('\n== 7. 两个宿主共用一个目录 ==')
for (const layout of ['single', 'per-record'] as const) {
  const root = freshRoot()
  const domain = rulesDomain({ layout })
  const [ops, agentHost] = [await boot(root, { domain }), await boot(root, { domain })]
  const changes = [ops, agentHost].map((host) => {
    const seen: string[] = []
    host.ctx.on('domain/changed', (change) => { seen.push(change.table) })
    return seen
  })
  await store(ops)!.propose(rule(2), '运维在另一个进程里加规则')
  await store(ops)!.activate('same-version-failed', 1, '上线')
  const before: number = platformRuns
  for (let i = 0; i < 3; i++) await deploy(agentHost, '2.3')
  log(`${layout}：另一个宿主里连发三次 2.3，平台执行 ${platformRuns - before} 次`)
  for (const host of [ops, agentHost]) {
    await store(host)!.flush()
    await host.ctx.fiber.dispose()
  }
  const [opsSaw, agentSaw] = changes.map(seen => [...new Set(seen)].join('+') + ` ${seen.length} 条`)
  log(`${layout}：domain/changed 运维宿主收到 ${opsSaw}，agent 宿主收到 ${agentSaw}`)
  assert.deepEqual(changes, [['revisions', 'active'], ['events', 'events', 'events']])
  const later = await boot(root, { domain })
  log(`${layout}：两边都关掉再打开：生效规则 [${store(later)!.active().join(', ')}]，历史 ${store(later)!.history().length} 条`)
  assert.equal(platformRuns - before, 3)
  assert.deepEqual(store(later)!.active(), layout === 'single' ? [] : ['same-version-failed@1'])
  assert.equal(store(later)!.history().length, 3)
  await later.ctx.fiber.dispose()
}
