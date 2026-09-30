/** Drive the release-rules engine through a scripted agent: block a third retry, warn on lookup, and probe its limits. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { HarnessError, LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolGuard } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { ReleaseRules, failedTwiceIn24h, lastReleaseFailed, rulePlugin, type Config, type ReleaseRule } from './release-rules.ts'

const log = (msg: string) => { console.log(msg) }

// ── 脚本化模型：每一轮一组动作，并记下每次请求的最后几条消息 ─────────────────
type Action = () => StreamChunk[]
const textOf = (message: Message | undefined) => (message?.content ?? [])
  .map(b => b.type === 'text' ? b.text : b.type === 'tool-result' ? b.content.map(c => c.type === 'text' ? c.text : '').join('') : '')
  .join('')
const isToolResult = (message: Message | undefined) => message?.content.some(b => b.type === 'tool-result') === true

class ScriptedModel extends LlmAdapter {
  readonly turns: Action[][] = []
  readonly requests: Message[][] = []
  private current: Action[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options.messages)
    const last = options.messages.at(-1)
    if (!isToolResult(last) && last?.role === 'user' && last.source.kind === 'user') this.current = this.turns.shift() ?? []
    const action = this.current.shift()
    assert.ok(action, `the scripted model has no action for: ${textOf(last).slice(0, 60)}`)
    for (const chunk of action()) yield chunk
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
const call = (name: string, args: object): Action => () => {
  const id = ToolCallId(`call-${++callSeq}`)
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

// ── 合成的发布平台：2.3 这个版本每次都部署失败 ───────────────────────────────
let now = Date.UTC(2026, 8, 27, 2)
const HOUR = 3600_000
interface Deploy { service: string; version: string; outcome: 'succeeded' | 'failed' }
const platform: Deploy[] = []
const deployRelease = defineTool({
  name: 'deploy_release',
  description: 'Deploy one version of a service to the synthetic release platform.',
  parameters: { service: { type: 'string', required: true }, version: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { service: { type: 'string', required: true }, version: { type: 'string', required: true }, outcome: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: `${value.service} ${value.version} ${value.outcome}` }],
  },
  execute(args) {
    // 平台接受 "v2.3" 和 "2.3" 两种写法。
    const version = args.version.replace(/^v/i, '')
    const deploy: Deploy = { service: args.service, version, outcome: version === '2.3' ? 'failed' : 'succeeded' }
    platform.push(deploy)
    return Promise.resolve({ ...deploy })
  },
})
const lookupRelease = defineTool({
  name: 'lookup_release',
  description: 'Show the latest deployment of one service.',
  parameters: { service: { type: 'string', required: true } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute(args) {
    const last = platform.filter(d => d.service === args.service).at(-1)
    return Promise.resolve(last === undefined ? `${args.service}: no deployment` : `${args.service}: ${last.version} ${last.outcome}`)
  },
})

// ── 宿主 ───────────────────────────────────────────────────────────────
interface Host { ctx: Context; model: ScriptedModel; engine: ReturnType<Context['plugin']>; rules: ReturnType<Context['plugin']>[]; agent: Agent }
async function boot(config: Config = {}): Promise<Host> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const model = new ScriptedModel()
  ctx.llm.registerAdapter(['mock'], model)
  ctx.tools.register(deployRelease)
  ctx.tools.register(lookupRelease)
  const engine = ctx.plugin(ReleaseRules, { now: () => now, ...config })
  await engine
  const rules = [ctx.plugin(rulePlugin(failedTwiceIn24h)), ctx.plugin(rulePlugin(lastReleaseFailed))]
  for (const rule of rules) await rule
  const { agent } = await ctx.agents.create({ sessionId: SessionId('oncall'), agentOptions: { provider: 'mock', model: 'mock' } })
  return { ctx, model, engine, rules, agent }
}
async function ask(host: Host, text: string, ...actions: Action[]): Promise<void> {
  host.model.turns.push(actions)
  host.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await host.agent.whenIdle()
  assert.equal(host.model.turns.length, 0)
}
// oxlint-disable-next-line typescript/no-deprecated -- the demo reads the whole log on purpose
const events = (agent: Agent): readonly SessionEvent[] => agent.session.snapshotEvents()
/** Tool results of the last `n` calls, in order. */
const results = (agent: Agent, n: number) => events(agent).flatMap(e => e.type === 'tool/result'
  ? e.data.message.content.flatMap(b => b.type === 'tool-result' ? [{ text: b.content.map(c => c.type === 'text' ? c.text : '').join(''), isError: b.isError === true }] : [])
  : []).slice(-n)
const deploy = (version: string) => call('deploy_release', { service: 'payment-api', version })

log('== 1. 同一版本部署失败两次，第三次被规则拦下 ==')
const host = await boot()
const errorsOf = new Map<string, { message: string; info?: unknown }>()
host.ctx.on('tools/result', (exec, result) => {
  if (result.isError) errorsOf.set(exec.name, { ...result.error })
  return undefined
})
await ask(host, '把 payment-api 2.3 发上去，失败就重试', deploy('2.3'), deploy('2.3'), deploy('2.3'), reply('停止重试。'))
for (const [i, r] of results(host.agent, 3).entries()) {
  log(`第 ${i + 1} 次 deploy_release -> ${r.isError ? `isError=true\n  ${r.text}` : r.text}`)
}
const denied = errorsOf.get('deploy_release')
log(`平台实际执行了 ${platform.length} 次；规则引擎记下的历史 ${host.ctx.releaseRules.history().length} 条`)
log(`被拒调用的结果里带错误码吗：${denied?.info === undefined ? '没有，只有 message' : '有'}`)
assert.deepEqual(results(host.agent, 3), [
  { text: 'payment-api 2.3 failed', isError: false },
  { text: 'payment-api 2.3 failed', isError: false },
  { text: 'Error: [same-version-failed-twice] payment-api 2.3 在 24 小时内已失败 2 次，停止重试', isError: true },
])
assert.equal(platform.length, 2)
assert.equal(host.ctx.releaseRules.history().length, 2)
assert.equal(denied?.info, undefined)
// 对照：工具体自己抛错时，结果里的 error 长什么样。
const stringOutput = { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] } as const
host.ctx.tools.register(defineTool({ name: 'throw_plain', description: 'Throw a plain Error.', parameters: {}, output: stringOutput, execute(): Promise<string> { throw new Error('platform down') } }))
host.ctx.tools.register(defineTool({ name: 'throw_harness', description: 'Throw a HarnessError.', parameters: {}, output: stringOutput, execute(): Promise<string> { throw new HarnessError('platform down', 'PLATFORM_DOWN') } }))
await ask(host, '试两个会抛错的工具', call('throw_plain', {}), call('throw_harness', {}), reply('都抛错了。'))
log(`工具体抛普通 Error：${JSON.stringify(errorsOf.get('throw_plain'))}`)
log(`工具体抛 HarnessError：${JSON.stringify(errorsOf.get('throw_harness'))}`)
assert.deepEqual(errorsOf.get('throw_plain'), { message: 'platform down' })
assert.deepEqual(errorsOf.get('throw_harness'), { message: 'platform down', info: { name: 'HarnessError', code: 'PLATFORM_DOWN' } })

log('')
log('== 2. 把被拒的调用也记成失败：窗口被一直续上 ==')
let variantNow = now
const variant = await boot({ now: () => variantNow, recordErrors: true })
const deployRefund = () => call('deploy_release', { service: 'refund-api', version: '2.3' })
const refundRuns = () => platform.filter(d => d.service === 'refund-api').length
await ask(variant, '把 refund-api 2.3 发上去，失败就重试', deployRefund(), deployRefund(), deployRefund(), reply('停止重试。'))
log(`第 0 小时：三次调用，平台执行 ${refundRuns()} 次，历史 ${variant.ctx.releaseRules.history().length} 条`)
variantNow += 23 * HOUR
await ask(variant, '过了 23 小时，再试', deployRefund(), deployRefund(), reply('还是被拦。'))
const at23 = results(variant.agent, 2).map(r => r.isError)
log(`第 23 小时：再试两次，被拒 ${at23.filter(Boolean).length} 次，历史 ${variant.ctx.releaseRules.history().length} 条`)
variantNow += 2 * HOUR
await ask(variant, '过了 25 小时，再试', deployRefund(), reply('还是被拦。'))
const at25 = results(variant.agent, 1)[0]
log(`第 25 小时：${at25?.text}`)
log(`平台一共执行 ${refundRuns()} 次`)
assert.equal(refundRuns(), 2)
assert.deepEqual(at23, [true, true])
assert.equal(variant.ctx.releaseRules.history().length, 6)
assert.match(at25?.text ?? '', /^Error: \[same-version-failed-twice\] refund-api 2\.3 在 24 小时内已失败 2 次/)

log('')
log('== 3. 查询时追加告警：工具结果后面多一条插件消息 ==')
await ask(host, 'payment-api 现在什么情况', call('lookup_release', { service: 'payment-api' }), reply('最近一次发布失败了。'))
const seen = host.model.requests.at(-1) ?? []
for (const m of seen.slice(-2)) log(`  ${m.role}/${m.source.kind}: ${textOf(m)}`)
const alertEvent = events(host.agent).findLast(e => e.type === 'user/message')
assert.ok(alertEvent?.type === 'user/message')
log(`会话日志里这条告警的来源：${JSON.stringify(alertEvent.data.source)}`)
assert.deepEqual(seen.slice(-2).map(m => [m.role, m.source.kind, textOf(m)]), [
  ['user', 'tool', 'payment-api: 2.3 failed'],
  ['user', 'plugin', 'release-rules 告警：[last-release-failed] payment-api 最近一次发布 2.3 失败'],
])
assert.deepEqual(alertEvent.data.source, { kind: 'plugin', plugin: 'release-rules' })

log('')
log('== 4. 版本写成 v2.3：规则没认出来，平台照样部署 ==')
const runsBeforeV = platform.length
await ask(host, '那试试 v2.3', deploy('v2.3'), reply('又失败了。'))
log(`deploy_release(v2.3) -> ${results(host.agent, 1)[0]?.text}；平台执行次数 +${platform.length - runsBeforeV}`)
const normalized = await boot({ normalize: (service, version) => ({ service: service.trim(), version: version.replace(/^v/i, '') }) })
await ask(normalized, '把 payment-api 2.3 发上去', deploy('2.3'), deploy('v2.3'), deploy('v2.3'), reply('停了。'))
log(`引擎按工具体同样的写法规范化后，2.3、v2.3、v2.3 三次：第 3 次被拦`)
log(`  ${results(normalized.agent, 1)[0]?.text}`)
assert.equal(results(host.agent, 1)[0]?.text, 'payment-api 2.3 failed')
assert.equal(platform.length - runsBeforeV, 3)
assert.match(results(normalized.agent, 1)[0]?.text ?? '', /^Error: \[same-version-failed-twice\] payment-api 2\.3 在 24 小时内已失败 2 次/)

log('')
log('== 5. 卸载规则、重载引擎 ==')
const again = () => deploy('2.3')
const lookup = () => call('lookup_release', { service: 'payment-api' })
/** Plugin messages the model saw right after the last tool result, i.e. alerts attached to the latest lookup. */
const alerts = () => {
  const seenNow = host.model.requests.at(-1) ?? []
  return seenNow.slice(seenNow.findLastIndex(isToolResult) + 1).filter(m => m.source.kind === 'plugin').map(textOf)
}
const ruleStates = () => host.rules.map(r => r.state)
const ruleFiber = host.ctx.plugin(rulePlugin({ ...failedTwiceIn24h, id: 'hot-rule' }))
await ruleFiber
const withHot = host.ctx.releaseRules.list()
log(`已注册的规则：${withHot.join(', ')}`)
await ruleFiber.dispose()
const withoutHot = host.ctx.releaseRules.list()
log(`卸载 hot-rule 之后：${withoutHot.join(', ')}`)
const before = host.ctx.releaseRules.evaluate('payment-api', '2.3').filter(f => f.severity === 'block').map(f => f.ruleId)
log(`重载前，引擎对 payment-api 2.3 的判断：${before.join(', ')}`)
const oldEngine = host.ctx.releaseRules
const oldHistory = oldEngine.history().length
await host.engine.dispose()
const pending = ruleStates()
log(`引擎卸载后，两条规则插件的状态：${pending.join(', ')}（0 = 等待依赖）`)
// 往已卸载的旧实例上直接塞一条必拦规则和一条必告警规则：它的守卫和监听器若还在，就会生效。
const staleBlock: ReleaseRule = { id: 'stale-block', severity: 'block', evaluate: () => '旧实例拦截' }
const staleWarn: ReleaseRule = { id: 'stale-warn', severity: 'warn', evaluate: () => '旧实例告警' }
oldEngine.register(staleBlock)
oldEngine.register(staleWarn)
const runsBeforeGap = platform.length
await ask(host, '引擎不在，发 2.3 再查一下', again(), lookup(), reply('发了。'))
const [gapDeploy] = results(host.agent, 2)
const gapAlerts = alerts().length
const gapRuns = platform.length - runsBeforeGap
log(`卸载期间（旧实例上挂着必拦、必告警规则）：deploy_release(2.3) -> ${gapDeploy?.text}，平台执行 +${gapRuns}，查询告警 ${gapAlerts} 条，旧实例历史 ${oldEngine.history().length} 条（卸载前 ${oldHistory}）`)
const reloaded = host.ctx.plugin(ReleaseRules, { now: () => now })
await reloaded
await new Promise(resolve => setTimeout(resolve, 10))
const reloadedHistory = host.ctx.releaseRules.history().length
log(`引擎重新加载：规则自动回来了 ${host.ctx.releaseRules.list().join(', ')}，历史 ${reloadedHistory} 条`)
await ask(host, '查一下 payment-api', lookup(), reply('查了。'))
const alertsAfterReload = alerts().length
log(`重载后先查询：告警 ${alertsAfterReload} 条`)
await ask(host, '再发一次 2.3', again(), reply('发了。'))
log(`deploy_release(2.3) -> ${results(host.agent, 1)[0]?.text}（重载前会被拦下，现在规则没有触发）`)
await ask(host, '再查一下 payment-api', lookup(), reply('查了。'))
const alertsAfterDeploy = alerts()
log(`部署失败一次后再查询：告警 ${alertsAfterDeploy.length} 条 ${alertsAfterDeploy.join(' | ')}`)
const restarted = await boot()
const restartedHistory = restarted.ctx.releaseRules.history().length
await ask(restarted, '发 payment-api 2.3', again(), reply('发了。'))
log(`新宿主（相当于进程重启）：部署前历史 ${restartedHistory} 条，deploy_release(2.3) -> ${results(restarted.agent, 1)[0]?.text}`)
assert.deepEqual(withHot, ['same-version-failed-twice', 'last-release-failed', 'hot-rule'])
assert.deepEqual(withoutHot, ['same-version-failed-twice', 'last-release-failed'])
assert.deepEqual(before, ['same-version-failed-twice'])
assert.deepEqual(pending, [0, 0])
assert.equal(reloadedHistory, 0)
assert.deepEqual(gapDeploy, { text: 'payment-api 2.3 failed', isError: false })
assert.equal(gapRuns, 1)
assert.equal(gapAlerts, 0)
assert.equal(oldEngine.history().length, oldHistory)
assert.deepEqual(host.ctx.releaseRules.list(), ['same-version-failed-twice', 'last-release-failed'])
assert.equal(alertsAfterReload, 0)
assert.equal(results(host.agent, 2)[0]?.text, 'payment-api 2.3 failed')
assert.deepEqual(alertsAfterDeploy, ['release-rules 告警：[last-release-failed] payment-api 最近一次发布 2.3 失败'])
assert.equal(restartedHistory, 0)
assert.equal(results(restarted.agent, 1)[0]?.text, 'payment-api 2.3 failed')

log('')
log('== 6. 24 小时窗口：时钟拨快 25 小时后放行 ==')
now += 25 * HOUR
await ask(normalized, '过了一天，再试一次', deploy('2.3'), reply('还是失败。'))
log(`deploy_release(2.3) -> ${results(normalized.agent, 1)[0]?.text}（25 小时前的 2 次失败都已出了窗口）`)
assert.equal(results(normalized.agent, 1)[0]?.text, 'payment-api 2.3 failed')

log('')
log('== 7. 守卫写成 async ==')
const asyncGuard = (async () => undefined) as unknown as ToolGuard
const disposeGuard = host.ctx.tools.guard(asyncGuard)
const deploysBefore = platform.length
await ask(host, '查一下 order-api，再发 order-api 1.0',
  call('lookup_release', { service: 'order-api' }), call('deploy_release', { service: 'order-api', version: '1.0' }), reply('都失败了。'))
const [lookupAsync, deployAsync] = results(host.agent, 2)
log(`lookup_release(order-api) -> ${lookupAsync?.text}`)
log(`deploy_release(order-api 1.0) -> ${deployAsync?.text}`)
log(`  平台执行次数没变：${platform.length === deploysBefore}`)
disposeGuard()
await ask(host, '再查一次', call('lookup_release', { service: 'order-api' }), reply('好了。'))
log(`去掉这个守卫后 lookup_release(order-api) -> ${results(host.agent, 1)[0]?.text}`)
assert.deepEqual([lookupAsync, deployAsync], Array.from({ length: 2 }, () => ({ text: 'Error: tool result must be losslessly JSON-serializable', isError: true })))
assert.equal(platform.length, deploysBefore)
assert.deepEqual(results(host.agent, 1)[0], { text: 'order-api: no deployment', isError: false })

log('')
log('== 8. 去掉强转，让 tsc 检查 async 守卫 ==')
const probeDir = join(dirname(fileURLToPath(import.meta.url)), `.tsc-probe-${process.pid}`)
const probe = (guard: string) => [
  `import type { Context } from '@deepseek-ai/cordis'`,
  `import type {} from '@deepseek-ai/dsh-tools'`,
  `declare const ctx: Context`,
  `ctx.tools.guard(${guard})`,
  '',
].join('\n')
mkdirSync(probeDir, { recursive: true })
let tscLines: string[]
try {
  writeFileSync(join(probeDir, 'async-guard.ts'), probe('async () => undefined'))
  writeFileSync(join(probeDir, 'sync-guard.ts'), probe('() => undefined'))
  writeFileSync(join(probeDir, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.json', include: ['*.ts'] }))
  const tsc = spawnSync(join(probeDir, '../../../node_modules/.bin/tsc'), ['--noEmit', '-p', join(probeDir, 'tsconfig.json')], { cwd: probeDir, encoding: 'utf8' })
  // vendor 源码本身在 strict 配置下有报错，只看两个探针文件自己的诊断。
  tscLines = tsc.stdout.split('\n').filter(line => /^(async|sync)-guard\.ts\(/.test(line))
} finally {
  rmSync(probeDir, { recursive: true, force: true })
}
for (const line of tscLines) log(line)
log(`sync-guard.ts 的报错：${tscLines.filter(line => line.startsWith('sync-')).length} 条`)
assert.deepEqual(tscLines, ["async-guard.ts(4,29): error TS2322: Type 'Promise<undefined>' is not assignable to type 'string'."])
