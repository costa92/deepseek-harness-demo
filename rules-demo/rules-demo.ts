/** Drive the release-rules engine through a scripted agent: block a third retry, warn on lookup, and probe its limits. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolGuard } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { ReleaseRules, failedTwiceIn24h, lastReleaseFailed, rulePlugin, type Config } from './release-rules.ts'

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
let denied: { message: string; info?: unknown } | undefined
host.ctx.on('tools/result', (exec, result) => {
  if (exec.name === 'deploy_release' && result.isError) denied = { ...result.error }
  return undefined
})
await ask(host, '把 payment-api 2.3 发上去，失败就重试', deploy('2.3'), deploy('2.3'), deploy('2.3'), reply('停止重试。'))
for (const [i, r] of results(host.agent, 3).entries()) {
  log(`第 ${i + 1} 次 deploy_release -> ${r.isError ? `isError=true\n  ${r.text}` : r.text}`)
}
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

log('')
log('== 2. 查询时追加告警：工具结果后面多一条插件消息 ==')
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
log('== 3. 版本写成 v2.3：规则没认出来，平台照样部署 ==')
await ask(host, '那试试 v2.3', deploy('v2.3'), reply('又失败了。'))
log(`deploy_release(v2.3) -> ${results(host.agent, 1)[0]?.text}；平台执行次数 ${platform.length}`)
const normalized = await boot({ normalize: (service, version) => ({ service: service.trim(), version: version.replace(/^v/i, '') }) })
await ask(normalized, '把 payment-api 2.3 发上去', deploy('2.3'), deploy('v2.3'), deploy('v2.3'), reply('停了。'))
log(`引擎按工具体同样的写法规范化后，2.3、v2.3、v2.3 三次：第 3 次被拦`)
log(`  ${results(normalized.agent, 1)[0]?.text}`)
assert.equal(results(host.agent, 1)[0]?.text, 'payment-api 2.3 failed')
assert.equal(platform.length, 5)
assert.match(results(normalized.agent, 1)[0]?.text ?? '', /^Error: \[same-version-failed-twice\] payment-api 2\.3 在 24 小时内已失败 2 次/)

log('')
log('== 4. 卸载规则、重载引擎 ==')
const again = () => deploy('2.3')
const ruleStates = () => host.rules.map(r => r.state)
const ruleFiber = host.ctx.plugin(rulePlugin({ ...failedTwiceIn24h, id: 'hot-rule' }))
await ruleFiber
log(`已注册的规则：${host.ctx.releaseRules.list().join(', ')}`)
await ruleFiber.dispose()
log(`卸载 hot-rule 之后：${host.ctx.releaseRules.list().join(', ')}`)
const before = host.ctx.releaseRules.evaluate('payment-api', '2.3').filter(f => f.severity === 'block').map(f => f.ruleId)
log(`重载前，引擎对 payment-api 2.3 的判断：${before.join(', ')}`)
await host.engine.dispose()
const pending = ruleStates()
log(`引擎卸载后，两条规则插件的状态：${pending.join(', ')}（0 = 等待依赖）`)
const reloaded = host.ctx.plugin(ReleaseRules, { now: () => now })
await reloaded
await new Promise(resolve => setTimeout(resolve, 10))
log(`引擎重新加载：规则自动回来了 ${host.ctx.releaseRules.list().join(', ')}，历史 ${host.ctx.releaseRules.history().length} 条`)
await ask(host, '再发一次 2.3', again(), reply('发了。'))
log(`deploy_release(2.3) -> ${results(host.agent, 1)[0]?.text}（重载前会被拦下，现在规则没有触发）`)
assert.deepEqual(before, ['same-version-failed-twice'])
assert.deepEqual(pending, [0, 0])
assert.deepEqual(host.ctx.releaseRules.list(), ['same-version-failed-twice', 'last-release-failed'])
assert.equal(results(host.agent, 1)[0]?.text, 'payment-api 2.3 failed')

log('')
log('== 5. 24 小时窗口：时钟拨快 25 小时后放行 ==')
now += 25 * HOUR
await ask(normalized, '过了一天，再试一次', deploy('2.3'), reply('还是失败。'))
log(`deploy_release(2.3) -> ${results(normalized.agent, 1)[0]?.text}（25 小时前的 2 次失败都已出了窗口）`)
assert.equal(results(normalized.agent, 1)[0]?.text, 'payment-api 2.3 failed')

log('')
log('== 6. 守卫写成 async ==')
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
