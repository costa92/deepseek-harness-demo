/** Run the release-rules engine under dsh's PTC mode: the model writes one `run_code` program and every deploy becomes a nested sub-call. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as checkpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import PtcRuntimeNode from '@deepseek-ai/dsh-ptc-runtime-node'
import { ReleaseRules, failedTwiceIn24h, rulePlugin } from './release-rules.ts'
import { readDeploys } from './log-miner.ts'

const log = (msg: string) => { console.log(msg) }
const base = mkdtempSync(join(tmpdir(), 'dsh-code-mode-'))
process.on('exit', () => { rmSync(base, { recursive: true, force: true }) })
const now = Date.UTC(2026, 8, 28, 2)

// ── 脚本化模型：每一轮一组动作，记下每次请求的工具列表和系统提示 ─────────────────
type Action = () => StreamChunk[]
const textOf = (message: Message | undefined) => (message?.content ?? [])
  .map(b => b.type === 'text' ? b.text : b.type === 'tool-result' ? b.content.map(c => c.type === 'text' ? c.text : '').join('') : '')
  .join('')
class ScriptedModel extends LlmAdapter {
  readonly turns: Action[][] = []
  readonly requests: GenerateOptions[] = []
  private current: Action[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const last = options.messages.at(-1)
    // 挂了审批服务时，运行时上下文会作为插件消息追加在用户消息后面（第 24 篇），按“最近的用户消息之后还没有回复”判断新一轮。
    const lastUser = options.messages.findLastIndex(m => m.role === 'user' && m.source.kind === 'user')
    if (!options.messages.slice(lastUser + 1).some(m => m.role === 'assistant')) this.current = this.turns.shift() ?? []
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
const batch = (name: string, list: object[]): Action => () => {
  const blocks = list.map((args, index) => ({ index, id: ToolCallId(`call-${++callSeq}`), json: JSON.stringify(args) }))
  return [
    ...blocks.flatMap(({ index, id, json }): StreamChunk[] => [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name, argumentsDelta: json },
      { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: json } },
    ]),
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}
const runCode = (code: string, extra: object = {}) => call('run_code', { code, description: 'Deploy releases', ...extra })

// ── 合成发布平台：2.3 每次失败；结构化结果放进 presentationMeta（第 23 篇） ─────────
const platform: string[] = []
let metaCalls = 0
function deployTool(parallel: boolean) {
  return defineTool({
    name: 'deploy_release',
    description: 'Deploy one version of a service to the synthetic release platform.',
    parameters: { service: { type: 'string', required: true }, version: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { service: { type: 'string', required: true }, version: { type: 'string', required: true }, outcome: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `${value.service} ${value.version} ${value.outcome}` }],
      presentationMeta: (_args, value) => { metaCalls++; return { ...value } },
    },
    ...parallel ? { isConcurrencySafe: () => true } : {},
    async execute(args) {
      const version = args.version.replace(/^v/i, '')
      platform.push(`${args.service} ${version}`)
      await new Promise(resolve => setTimeout(resolve, 20))
      return { service: args.service, version, outcome: version === '2.3' ? 'failed' : 'succeeded' }
    },
  })
}

// ── 宿主：PTC 进程运行时（第 20 篇同款），tools 的 mode 设成 ptc ─────────────────
const logs = join(base, 'sessions')
interface Host { ctx: Context; model: ScriptedModel; agent: Agent }
async function boot(id: string, options: { mode?: 'ptc' | 'native'; parallel?: boolean; approval?: boolean; seen?: number[] } = {}): Promise<Host> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: options.mode ?? 'ptc' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: logs, compression: 'none' })
  await ctx.plugin(checkpointPolicy)
  await ctx.plugin(LocalSandboxProvider, {})
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: base })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: base })
  await ctx.plugin(PtcRuntimeNode)
  if (options.approval === true) await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(AgentLoop, { agents: [] })
  const model = new ScriptedModel()
  ctx.llm.registerAdapter(['mock'], model)
  ctx.tools.register(deployTool(options.parallel === true))
  // 排在规则引擎的守卫之前，记下每次守卫判断时引擎的历史条数。
  const seen = options.seen
  if (seen !== undefined) ctx.tools.guard((exec) => { if (exec.name === 'deploy_release') seen.push(ctx.releaseRules.history().length); return undefined })
  await ctx.plugin(ReleaseRules, { now: () => now, normalize: (service: string, version: string) => ({ service, version: version.replace(/^v/i, '') }) })
  await ctx.plugin(rulePlugin(failedTwiceIn24h))
  const { agent } = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'mock', model: 'mock' } })
  return { ctx, model, agent }
}
async function ask(host: Host, text: string, ...actions: Action[]): Promise<void> {
  host.model.turns.push(actions)
  host.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await host.agent.whenIdle()
  await host.ctx.sessions.flush(host.agent.session)
  assert.equal(host.model.turns.length, 0)
}
// oxlint-disable-next-line typescript/no-deprecated -- the demo reads the whole log on purpose
const events = (agent: Agent): readonly SessionEvent[] => agent.session.snapshotEvents()
const toolResults = (agent: Agent) => events(agent).flatMap(e => e.type === 'tool/result'
  ? e.data.message.content.flatMap(b => b.type === 'tool-result' ? [{ text: b.content.map(c => c.type === 'text' ? c.text : '').join(''), isError: b.isError === true }] : [])
  : [])
const lastResult = (agent: Agent) => toolResults(agent).at(-1)

const deployArgs = (version: string, service = 'payment-api') => JSON.stringify({ service, version }).replaceAll('"', "'")
const ptcDispatches = (agent: Agent) => events(agent).flatMap(e => e.type === 'tool/ptc-dispatch' ? [e.data] : [])

log('== 1. PTC 模式：模型只拿到 run_code，工具变成程序里的 SDK ==')
const oncall = await boot('oncall')
let preExecuted = 0
oncall.ctx.on('tools/pre-execute', async (_exec, next) => { preExecuted++; return next() })
await ask(oncall, '发布 payment-api 2.3', call('deploy_release', { service: 'payment-api', version: '2.3' }), reply('只能写程序调。'))
const first = oncall.model.requests[0]
const system = textOf(first?.messages.find(m => m.role === 'system'))
log(`发给模型的工具 schema：${first?.tools?.map(t => t.name).join(', ')}`)
const sdkMarks = ['deploy_release: {', 'declare class ToolCallError', 'declare const tools']
log(`系统提示里的 SDK 声明：${sdkMarks.filter(m => system.includes(m)).map(m => `\`${m}\``).join('、')}`)
const direct = lastResult(oncall.agent)
log('直接调 deploy_release，模型收到：')
for (const part of (direct?.text ?? '').split(/: (?=only)| (?=— call)/)) log(`  ${part}`)
log(`pre-execute 监听器收到 ${preExecuted} 次调用`)
assert.deepEqual(first?.tools?.map(t => t.name), ['run_code'])
assert.deepEqual(sdkMarks.filter(m => system.includes(m)), sdkMarks)
assert.equal(direct?.isError, true)
assert.match(direct?.text ?? '', /^Error: unknown tool "deploy_release": only `run_code` is callable directly/)
assert.equal(platform.length, 0)
assert.equal(preExecuted, 0)

log('\n== 2. 程序里重试：子调用照样过守卫，拒绝变成程序里的异常 ==')
const RETRY = [
  'const out = []',
  'for (let i = 1; i <= 3; i++) {',
  `  try { out.push(\`\${i}: \${(await tools.deploy_release(${deployArgs('2.3')})).outcome}\`) }`,
  '  catch (e) { out.push(`${i}: ${e.name}(${e.toolName})\n   ${e.message}`) }',
  '}',
  'return out.join("\\n")',
].join('\n')
await ask(oncall, '发布 payment-api 2.3，失败就重试', runCode(RETRY), reply('第三次被规则拦下了。'))
const retried = lastResult(oncall.agent)
log('模型收到：')
for (const line of (retried?.text ?? '').split('\n')) log(`  ${line}`)
log(`平台执行 ${platform.length} 次，规则引擎的历史 ${oncall.ctx.releaseRules.history().length} 条（tools/result 对子调用也触发）`)
assert.deepEqual(retried, { isError: false, text: [
  '1: failed', '2: failed',
  '3: ToolCallError(deploy_release)', '   [same-version-failed-twice] payment-api 2.3 在 24 小时内已失败 2 次，停止重试',
].join('\n') })
assert.equal(platform.length, 2)
assert.equal(oncall.ctx.releaseRules.history().length, 2)
const SWALLOW = `for (let i = 0; i < 3; i++) {\n  try { await tools.deploy_release(${deployArgs('2.3')}) } catch {}\n}\nreturn "已尝试 3 次"`
await ask(oncall, '再发一次，别报错', runCode(SWALLOW), reply('发完了。'))
const swallowed = lastResult(oncall.agent)
const deniedInLog = ptcDispatches(oncall.agent).filter(d => d.isError).length
log(`程序把异常吞掉时，模型收到：${swallowed?.text}（这次 3 次都被拒，平台仍是 ${platform.length} 次）`)
assert.deepEqual(swallowed, { isError: false, text: '已尝试 3 次' })
assert.equal(platform.length, 2)
assert.equal(deniedInLog, 4)

log('\n== 3. 会话日志：部署记在 tool/ptc-dispatch 里，第 23 篇的挖掘模块读不到 ==')
const calls = events(oncall.agent).flatMap(e => e.type === 'tool/call' ? [e.data.name] : [])
const dispatches = ptcDispatches(oncall.agent)
log(`tool/call：${calls.join('、')}；tool/ptc-dispatch：${dispatches.length} 条`)
log(`tool/ptc-dispatch 的字段：${Object.keys(dispatches[0] ?? {}).sort().join(', ')}`)
const reader = new Context()
await reader.plugin(SessionStore)
await reader.plugin(SessionProjectionRegistry)
await reader.plugin(JsonlSessionPersistence, { root: logs, compression: 'none' })
await reader.plugin(SqliteSessionQueryEngine, { path: join(base, 'session-search.db') })
const records = await readDeploys(reader, 'deploy_release')
log(`readDeploys 读回 ${records.length} 条：${records.map(r => `${r.ref} ${r.kind}`).join('、')}（直接调用被拒的那次）`)
assert.deepEqual(calls, ['deploy_release', 'run_code', 'run_code'])
assert.equal(dispatches.length, 6)
assert.deepEqual(Object.keys(dispatches[0] ?? {}).sort(), ['arguments', 'content', 'isError', 'name', 'parentCallId', 'rootCallId', 'subCallId'])
assert.deepEqual(records.map(r => [r.ref, r.kind]), [['oncall#11', 'error']])
const ptcMeta = metaCalls
const metaNative = await boot('meta-native', { mode: 'native' })
await ask(metaNative, '发布 inventory-api 1.0', call('deploy_release', { service: 'inventory-api', version: '1.0' }), reply('发好了。'))
const metaResult = events(metaNative.agent).findLast(e => e.type === 'tool/result')
assert.ok(metaResult?.type === 'tool/result')
log(`presentationMeta 被调用：PTC 的 6 次子调用 ${ptcMeta} 次；原生模式部署 1 次，${metaCalls - ptcMeta} 次`)
log(`  原生 tool/result.meta = ${JSON.stringify(metaResult.data.meta)}`)
assert.equal(ptcMeta, 0)
assert.equal(metaCalls - ptcMeta, 1)
assert.deepEqual(metaResult.data.meta, { service: 'inventory-api', version: '1.0', outcome: 'succeeded' })

log('\n== 4. 拒绝带错误码：日志里有，模型和程序都拿不到 ==')
const frozen = (ctx: Context) => ctx.on('tools/pre-execute', async (exec, next) =>
  exec.name === 'deploy_release' && (exec.arguments as { version?: unknown }).version === '9.9'
    ? { kind: 'deny' as const, reason: '9.9 已冻结', info: { name: 'ReleaseFrozen', code: 'RELEASE_FROZEN' } }
    : next())
const native = await boot('frozen-native', { mode: 'native' })
frozen(native.ctx)
await ask(native, '发布 9.9', call('deploy_release', { service: 'payment-api', version: '9.9' }), reply('冻结了。'))
const nativeResult = events(native.agent).findLast(e => e.type === 'tool/result')
assert.ok(nativeResult?.type === 'tool/result')
log(`原生：模型收到 ${lastResult(native.agent)?.text}`)
log(`  tool/result.error = ${JSON.stringify(nativeResult.data.error)}`)
const ptc = await boot('frozen-ptc')
frozen(ptc.ctx)
await ask(ptc, '发布 9.9', runCode(`try { await tools.deploy_release(${deployArgs('9.9')}) } catch (e) { return Object.keys(e).concat("message").join(", ") }`), reply('冻结了。'))
const ptcDenied = ptcDispatches(ptc.agent)[0]
log(`PTC：程序里的异常只有 ${lastResult(ptc.agent)?.text}`)
log(`  tool/ptc-dispatch.error = ${JSON.stringify(ptcDenied?.error)}`)
assert.equal(lastResult(native.agent)?.text, 'Error: 9.9 已冻结')
assert.deepEqual(nativeResult.data.error, { name: 'ReleaseFrozen', code: 'RELEASE_FROZEN' })
assert.equal(lastResult(ptc.agent)?.text, 'name, toolName, message')
assert.deepEqual(ptcDenied?.error, { name: 'ReleaseFrozen', code: 'RELEASE_FROZEN' })

log('\n== 5. Promise.all 并发三次：工具声明可并发，守卫就拦不住 ==')
const PARALLEL = `const all = [1, 2, 3].map(() => tools.deploy_release(${deployArgs('2.3', 'order-api')}))\nreturn (await Promise.allSettled(all)).map(r => r.status === "fulfilled" ? r.value.outcome : "被拒").join(", ")`
const outcomes: string[][] = []
for (const parallel of [false, true]) {
  const before = platform.length
  const seen: number[] = []
  const h = await boot(`parallel-${parallel}`, { parallel, seen })
  await ask(h, 'order-api 2.3 并发发三次', runCode(PARALLEL), reply('好了。'))
  outcomes.push([lastResult(h.agent)?.text ?? '', String(platform.length - before), seen.join(', ')])
  log(`${parallel ? '声明 isConcurrencySafe' : '不声明（默认独占）'}：${lastResult(h.agent)?.text}；平台执行 ${platform.length - before} 次；守卫判断时的历史条数 ${seen.join(', ')}`)
}
assert.deepEqual(outcomes, [['failed, failed, 被拒', '2', '0, 1, 2'], ['failed, failed, failed', '3', '0, 0, 0']])
const nativeOutcomes: string[][] = []
for (const parallel of [false, true]) {
  const before = platform.length
  const seen: number[] = []
  const h = await boot(`native-parallel-${parallel}`, { mode: 'native', parallel, seen })
  const three = Array.from({ length: 3 }, () => ({ service: 'stock-api', version: '2.3' }))
  await ask(h, 'stock-api 2.3 一次发三个', batch('deploy_release', three), reply('好了。'))
  const results = toolResults(h.agent).map(r => r.isError ? '被拒' : r.text.split(' ').at(-1))
  nativeOutcomes.push([results.join(', '), String(platform.length - before), seen.join(', ')])
  log(`原生模式一条消息 3 个调用，${parallel ? '声明 isConcurrencySafe' : '不声明'}：${results.join(', ')}；平台执行 ${platform.length - before} 次；守卫判断时的历史条数 ${seen.join(', ')}`)
}
assert.deepEqual(nativeOutcomes, [['failed, failed, 被拒', '2', '0, 1, 2'], ['failed, failed, failed', '3', '0, 0, 0']])

log('\n== 6. 审批：子调用的 callId 不在 tool/call 里；等审批的时间算进程序超时 ==')
const approve = await boot('approve', { approval: true })
approve.ctx.on('tools/pre-execute', async (exec, next) =>
  exec.name === 'deploy_release' && (exec.arguments as { service?: unknown }).service === 'billing-api'
    ? { kind: 'ask' as const, reason: '部署 billing-api 需要人工确认' }
    : next())
const answers: string[] = []
let answerDelay = 0
let lateAnswer: Promise<void> = Promise.resolve()
approve.ctx.on('approval/request', (req) => {
  // 第 24 篇的做法：按 callId 回发起方会话日志的 tool/call 找参数。子调用要到 tool/ptc-dispatch-start 里找。
  const log = events(req.agent)
  const viaCall = log.find(e => e.type === 'tool/call' && e.data.callId === req.callId)
  const viaStart = log.find(e => e.type === 'tool/ptc-dispatch-start' && e.data.subCallId === req.callId)
  answers.push(`应答者收到 callId=${req.callId}`)
  answers.push(`  tool/call 里查：${viaCall === undefined ? '没有' : '有'}；tool/ptc-dispatch-start 里查：${viaStart?.type === 'tool/ptc-dispatch-start' ? JSON.stringify(viaStart.data.arguments) : '没有'}`)
  const answer = new Promise<void>(resolve => setTimeout(resolve, answerDelay)).then(() => 'allowed-once' as const)
  lateAnswer = answer.then(() => undefined)
  return answer
})
let before = platform.length
await ask(approve, '发布 billing-api 1.0', runCode(`return (await tools.deploy_release(${deployArgs('1.0', 'billing-api')})).outcome`), reply('发好了。'))
for (const line of answers.splice(0)) log(line)
log(`  批准，部署执行：${lastResult(approve.agent)?.text}`)
assert.equal(lastResult(approve.agent)?.text, 'succeeded')
assert.equal(platform.length - before, 1)
answerDelay = 1500
before = platform.length
await ask(approve, '发布 billing-api 1.1', runCode(`return (await tools.deploy_release(${deployArgs('1.1', 'billing-api')})).outcome`, { timeoutMs: 500 }), reply('超时了。'))
await lateAnswer
await new Promise(resolve => setTimeout(resolve, 50))
const decided = events(approve.agent).flatMap(e => e.type === 'approval/decided' ? [e.data.outcome] : [])
log('审批人 1.5 秒后才批准，run_code 的 timeoutMs 是 500：')
log(`  模型收到：${(lastResult(approve.agent)?.text ?? '').split('\n')[0]}`)
log(`  两次审批的结果：${decided.join('、')}；批准到达后平台执行 ${platform.length - before} 次`)
assert.match(lastResult(approve.agent)?.text ?? '', /^Error: code run failed \(timeout\): execution deadline reached \(500ms\)/)
assert.deepEqual(decided, ['allowed-once', 'cancelled'])
assert.equal(platform.length - before, 0)
answerDelay = 125_000
before = platform.length
await ask(approve, '发布 billing-api 1.2', runCode(`return (await tools.deploy_release(${deployArgs('1.2', 'billing-api')})).outcome`), reply('超时了。'))
await lateAnswer
await new Promise(resolve => setTimeout(resolve, 50))
const decidedDefault = events(approve.agent).flatMap(e => e.type === 'approval/decided' ? [e.data.outcome] : []).at(-1)
answers.splice(0)
log('不传 timeoutMs，审批人 125 秒后才批准：')
log(`  模型收到：${(lastResult(approve.agent)?.text ?? '').split('\n')[0]}`)
log(`  这次审批的结果：${decidedDefault}；批准到达后平台执行 ${platform.length - before} 次`)
assert.match(lastResult(approve.agent)?.text ?? '', /^Error: code run failed \(timeout\): execution deadline reached \(120000ms\)/)
assert.equal(decidedDefault, 'cancelled')
assert.equal(platform.length - before, 0)

log('\n== 7. 程序抛错：前面的部署已经生效，结果却是一条错误 ==')
const smoke = await boot('smoke')
before = platform.length
await ask(smoke, '发布 user-api 4.0 再做冒烟检查', runCode(
  `const r = await tools.deploy_release(${deployArgs('4.0', 'user-api')})\nconsole.log("deployed", r.version)\nthrow new Error("smoke check failed")`,
), reply('冒烟失败。'))
const failedRun = (lastResult(smoke.agent)?.text ?? '').split('\n')
const stackLines = failedRun.filter(l => l.startsWith('    at '))
log(`模型收到的第一行：${failedRun[0]}`)
log(`  接着 ${stackLines.length} 行堆栈（含宿主上的文件路径），然后是：`)
for (const line of failedRun.slice(failedRun.indexOf('Captured output:'))) log(`  ${line}`)
log(`平台执行 ${platform.length - before} 次（${platform.at(-1)}），规则引擎的历史 ${smoke.ctx.releaseRules.history().length} 条`)
assert.equal(failedRun[0], 'Error: code run failed (exception): Error: smoke check failed')
assert.ok(stackLines.some(l => l.includes('ptc-runtime-node')))
assert.deepEqual(failedRun.slice(failedRun.indexOf('Captured output:')), ['Captured output:', 'deployed 4.0', 'File sandbox: workspace-write; enforcement: full.'])
assert.equal(platform.length - before, 1)
assert.equal(smoke.ctx.releaseRules.history().length, 1)
