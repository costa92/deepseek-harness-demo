/** Run Claude Code command hooks on the release agent through dsh-hooks-claude-code and see how they stack with the part-21 rule engine. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as HooksClaude from '@deepseek-ai/dsh-hooks-claude-code'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import PtcRuntimeNode from '@deepseek-ai/dsh-ptc-runtime-node'
import { ReleaseRules, failedTwiceIn24h, rulePlugin } from './release-rules.ts'

const log = (msg: string) => { console.log(msg) }
const base = mkdtempSync(join(tmpdir(), 'dsh-hooks-'))
process.on('exit', () => { rmSync(base, { recursive: true, force: true }) })
const HERE = dirname(fileURLToPath(import.meta.url))
const now = Date.UTC(2026, 8, 28, 1)
// 宿主进程里有一个凭据形的环境变量（假值），看 hook 进程能不能读到。
process.env.RELEASE_API_TOKEN = 'demo-token'
// 再放一个 DSH_ 开头、名字不像凭据的变量。
process.env.DSH_DEMO_MARKER = 'on'

// ── 脚本化模型：每轮调一次工具，看到工具结果后回一句话 ─────────────────────────────
interface Call { name: string; args: object }
class ScriptedModel extends LlmAdapter {
  readonly calls: Call[] = []
  readonly requests: GenerateOptions[] = []
  onRequest: (count: number) => void = () => {}
  private seq = 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.onRequest(this.requests.length)
    const last = options.messages.at(-1)
    const call = last?.source.kind === 'tool' ? undefined : this.calls.shift()
    for (const chunk of call === undefined ? this.reply() : this.toolCall(call)) yield chunk
  }
  private reply(): StreamChunk[] {
    return [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '好的' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
  }
  private toolCall(call: Call): StreamChunk[] {
    const id = ToolCallId(`call-${++this.seq}`)
    const json = JSON.stringify(call.args)
    return [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: json },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: json } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
  }
}

// ── 合成发布平台：2.3 每次失败 ─────────────────────────────────────────────
function deployTool(platform: string[]) {
  return defineTool({
    name: 'deploy_release',
    description: 'Deploy one version of a service to the synthetic release platform.',
    parameters: { service: { type: 'string', required: true }, version: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { service: { type: 'string', required: true }, version: { type: 'string', required: true }, outcome: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `${value.service} ${value.version} ${value.outcome}` }],
    },
    execute(args) {
      platform.push(args.version)
      return Promise.resolve({ service: args.service, version: args.version, outcome: args.version === '2.3' ? 'failed' : 'succeeded' })
    },
  })
}

// ── hooks.json：每个事件一组 matcher，命令都指向同一个脚本，按参数换行为 ─────────────
interface HookSpec { event: string; mode: string; matcher?: string; timeout?: number }
function hooksJson(specs: HookSpec[]): object {
  const hooks: Record<string, object[]> = {}
  for (const { event, mode, matcher, timeout } of specs) {
    const command = { type: 'command', command: `node "\${CLAUDE_PLUGIN_ROOT}/release-hook.mjs" ${mode}`, ...timeout === undefined ? {} : { timeout } }
    ;(hooks[event] ??= []).push({ ...matcher === undefined ? {} : { matcher }, hooks: [command] })
  }
  return { hooks }
}

// ── 宿主 ───────────────────────────────────────────────────────────────
interface HostOptions {
  hooks: HookSpec[]
  rules?: boolean
  /** 在 hooks 桥接之前或之后注册一个“冻结窗口”pre-execute 监听器。 */
  freeze?: 'before' | 'after'
  approval?: boolean
  /** 在 hooks 桥接之后注册一个插件：'pre' 在 pre-execute 上只计数；'post' 在 post-execute 上计数，对 2.4 返回 block。 */
  later?: 'pre' | 'post'
  /** tools 用 PTC 模式（第 25 篇同款）。 */
  ptc?: boolean
}
interface Host { ctx: Context; model: ScriptedModel; agent: Agent; workspace: string; platform: string[]; asks: string[]; later: { pre: number; post: number }; logs: string[] }
let hosts = 0
async function boot(options: HostOptions): Promise<Host> {
  const workspace = join(base, `workspace-${++hosts}`)
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'hooks.json'), JSON.stringify(hooksJson(options.hooks)))
  const ctx = new Context()
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (m) => { logs.push(String(m.args[0])) } })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, options.ptc === true ? { mode: 'ptc' } : {})
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  if (options.ptc === true) {
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(PtcRuntimeNode)
  }
  const asks: string[] = []
  if (options.approval === true) {
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    // 脚本化的审批人：每次都批准。
    ctx.on('approval/request', (req) => {
      asks.push(req.reason ?? '-')
      return Promise.resolve('allowed-once')
    })
  }
  const freeze = () => ctx.on('tools/pre-execute', (exec, next) => exec.name === 'deploy_release'
    ? Promise.resolve({ kind: 'deny', reason: 'freeze-window 插件：发布冻结中' } as const)
    : next())
  if (options.freeze === 'before') freeze()
  await ctx.plugin(HooksClaude, { configPath: join(workspace, 'hooks.json'), pluginRoot: HERE })
  if (options.freeze === 'after') freeze()
  const later = { pre: 0, post: 0 }
  if (options.later === 'pre') {
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name === 'deploy_release') later.pre++
      return next()
    })
  }
  if (options.later === 'post') {
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name !== 'deploy_release') return next()
      later.post++
      return (exec.arguments as { version?: unknown }).version === '2.4'
        ? Promise.resolve({ kind: 'block', feedback: [{ type: 'text', text: '值班规则：2.4 先灰度' }] } as const)
        : next()
    })
  }
  if (options.rules === true) {
    await ctx.plugin(ReleaseRules, { now: () => now })
    await ctx.plugin(rulePlugin(failedTwiceIn24h))
  }
  const platform: string[] = []
  ctx.tools.register(deployTool(platform))
  const model = new ScriptedModel()
  ctx.llm.registerAdapter(['scripted'], model)
  const { agent } = await ctx.agents.create({
    sessionId: SessionId(`host-${hosts}`),
    meta: { cwd: workspace },
    agentOptions: { provider: 'scripted', model: 'mock' },
  })
  return { ctx, model, agent, workspace, platform, asks, later, logs }
}
async function deploy(host: Host, version: string): Promise<string> {
  host.model.calls.push({ name: 'deploy_release', args: { service: 'payment-api', version } })
  host.agent.followup(createUserMessage({ content: [{ type: 'text', text: `发布 payment-api ${version}` }], source: { kind: 'user' } }))
  await host.agent.whenIdle()
  assert.equal(host.model.calls.length, 0)
  return lastResult(host)
}
// oxlint-disable-next-line typescript/no-deprecated -- the demo reads the whole log on purpose
const events = (host: Host): readonly SessionEvent[] => host.agent.session.snapshotEvents()
function lastResult(host: Host): string {
  const result = events(host).findLast(e => e.type === 'tool/result')
  assert.ok(result?.type === 'tool/result')
  const [block] = result.data.message.content
  const text = block.content.map(c => c.type === 'text' ? c.text : '').join('')
  return block.isError ? `报错「${text}」` : text
}
type HookEntry = { mode: string; payload: Record<string, unknown>; cwd: string; token: string; dsh: string; at: number }
const hookLedger = (host: Host): HookEntry[] => {
  try {
    return readFileSync(join(host.workspace, 'hook-ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as HookEntry)
  } catch {
    return []
  }
}
const hookResults = (host: Host) => events(host).flatMap(e => e.type === 'hook/result' ? [e.data] : [])
const text = (message: Message) => message.content.map(b => b.type === 'text' ? b.text : '').join('')
const fromHooks = (m: Message) => m.source.kind === 'plugin' && m.source.plugin === 'hooks-claude-code'
/** Text of the hook-injected messages the model saw in its last request. */
const pluginMessages = (host: Host) => (host.model.requests.at(-1)?.messages ?? []).filter(fromHooks).map(text)

log('== 1. PreToolUse：退出码 2 拦下部署 ==')
const frozen = await boot({ hooks: [{ event: 'PreToolUse', matcher: 'deploy_release', mode: 'freeze' }], rules: true })
const blocked = await deploy(frozen, '2.4')
const [seen] = hookLedger(frozen)
assert.ok(seen)
log(`部署 2.4：${blocked}`)
log(`平台执行 ${frozen.platform.length} 次`)
log(`hook 从 stdin 收到的字段：${Object.keys(seen.payload).join(', ')}`)
log(`  tool_input = ${JSON.stringify(seen.payload.tool_input)}，transcript_path = ${JSON.stringify(seen.payload.transcript_path)}`)
log(`  hook 的工作目录是会话工作区：${String(seen.cwd === frozen.workspace)}；宿主的 RELEASE_API_TOKEN 在 hook 进程里：${seen.token}`)
log(`  宿主的 DSH_DEMO_MARKER 在 hook 进程里：${seen.dsh}`)
const [record] = hookResults(frozen)
log(`会话日志记下 hook/result：${JSON.stringify({ point: record?.point, decision: record?.decision, exitCode: record?.exitCode, stderrSummary: record?.stderrSummary })}`)
assert.equal(blocked, '报错「Error: 发布冻结中，2.4 等窗口结束再部署」')
assert.equal(frozen.platform.length, 0)
assert.deepEqual(Object.keys(seen.payload), ['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'tool_name', 'tool_input', 'tool_use_id'])
assert.equal(seen.payload.transcript_path, '')
assert.equal(seen.cwd, frozen.workspace)
assert.equal(seen.token, 'absent')
assert.equal(seen.dsh, 'absent')
assert.deepEqual(events(frozen).filter(e => e.type.startsWith('hook/')).map(e => e.type), ['hook/invoked', 'hook/result'])
assert.equal(record?.decision, 'block')
assert.equal(record?.exitCode, 2)

log('\n== 2. 这些写法都没拦住：部署照样执行 ==')
const attempts: { label: string; spec: HookSpec }[] = [
  { label: '退出码 1', spec: { event: 'PreToolUse', matcher: 'deploy_release', mode: 'exit1' } },
  { label: 'JSON 写 deny、退出码 1', spec: { event: 'PreToolUse', matcher: 'deploy_release', mode: 'deny-exit1' } },
  { label: '顶层 {"decision":"deny"}', spec: { event: 'PreToolUse', matcher: 'deploy_release', mode: 'top-deny' } },
  { label: 'hookSpecificOutput 缺 hookEventName', spec: { event: 'PreToolUse', matcher: 'deploy_release', mode: 'no-event-name' } },
  { label: 'hook 超时（timeout: 1 秒）', spec: { event: 'PreToolUse', matcher: 'deploy_release', mode: 'slow', timeout: 1 } },
  { label: 'matcher 写成 "deploy_release, rollback_release"', spec: { event: 'PreToolUse', matcher: 'deploy_release, rollback_release', mode: 'freeze' } },
  { label: '{"continue":false}', spec: { event: 'PreToolUse', matcher: 'deploy_release', mode: 'halt' } },
]
const records: string[] = []
for (const { label, spec } of attempts) {
  const host = await boot({ hooks: [spec] })
  const result = await deploy(host, '2.4')
  const [rec] = hookResults(host)
  const recorded = rec === undefined ? '没有 hook 记录' : `记为 ${rec.decision}${rec.exitCode === undefined ? '，没有退出码' : `，退出码 ${rec.exitCode}`}`
  records.push(recorded)
  log(`${label}：${result}（${recorded}）`)
  assert.equal(result, 'payment-api 2.4 succeeded')
  assert.deepEqual(host.platform, ['2.4'])
  await host.ctx.fiber.dispose()
}
const control = await boot({ hooks: [{ event: 'PreToolUse', matcher: 'deploy_release', mode: 'top-block' }] })
log(`对照，顶层 {"decision":"block"}：${await deploy(control, '2.4')}，平台执行 ${control.platform.length} 次`)
assert.deepEqual(records, ['记为 pass，退出码 1', '记为 pass，退出码 1', '记为 pass，退出码 0', '记为 pass，退出码 0', '记为 pass，没有退出码', '没有 hook 记录', '记为 stop，退出码 0'])
assert.equal(control.platform.length, 0)

log('\n== 3. 和第 21 篇守卫、其他 pre-execute 插件的先后 ==')
const asking = await boot({ hooks: [{ event: 'PreToolUse', matcher: 'deploy_release', mode: 'ask' }], rules: true, approval: true })
const askResults: string[] = []
for (let i = 0; i < 3; i++) askResults.push(await deploy(asking, '2.3'))
log(`hook 返回 ask，连续部署 2.3 三次：平台执行 ${asking.platform.length} 次，审批人收到 ${asking.asks.length} 次请求、都批准了`)
log(`  审批理由：${asking.asks[0]}`)
log(`  第 3 次：${askResults[2]}`)
assert.deepEqual(asking.platform, ['2.3', '2.3'])
assert.equal(asking.asks.length, 3)
assert.equal(askResults[2], '报错「Error: [same-version-failed-twice] payment-api 2.3 在 24 小时内已失败 2 次，停止重试」')

const allowing = await boot({ hooks: [{ event: 'PreToolUse', matcher: 'deploy_release', mode: 'allow' }], rules: true })
const allowResults: string[] = []
for (let i = 0; i < 3; i++) allowResults.push(await deploy(allowing, '2.3'))
log(`hook 返回 allow，同样三次：平台执行 ${allowing.platform.length} 次，第 3 次：${allowResults[2]}`)
assert.deepEqual(allowing.platform, ['2.3', '2.3'])
assert.equal(allowResults[2], askResults[2])

const hookFirst = await boot({ hooks: [{ event: 'PreToolUse', matcher: 'deploy_release', mode: 'ask' }], freeze: 'after', approval: true })
const hookFirstResult = await deploy(hookFirst, '2.4')
log(`冻结插件在 hooks 桥接之后注册：${hookFirstResult}，平台执行 ${hookFirst.platform.length} 次`)
const freezeFirst = await boot({ hooks: [{ event: 'PreToolUse', matcher: 'deploy_release', mode: 'ask' }], freeze: 'before', approval: true })
const freezeFirstResult = await deploy(freezeFirst, '2.4')
log(`冻结插件在 hooks 桥接之前注册：${freezeFirstResult}，hook 运行 ${hookLedger(freezeFirst).length} 次`)
assert.equal(hookFirstResult, 'payment-api 2.4 succeeded')
assert.deepEqual(hookFirst.platform, ['2.4'])
assert.equal(hookFirst.asks.length, 1)
assert.equal(freezeFirstResult, '报错「Error: freeze-window 插件：发布冻结中」')
assert.equal(hookLedger(freezeFirst).length, 0)

const denying = await boot({ hooks: [{ event: 'PreToolUse', matcher: 'deploy_release', mode: 'deny' }], later: 'pre' })
const denied = await deploy(denying, '2.4')
const allowingLater = await boot({ hooks: [{ event: 'PreToolUse', matcher: 'deploy_release', mode: 'allow' }], later: 'pre' })
await deploy(allowingLater, '2.4')
log(`hook 返回 deny：${denied}；后注册的 pre-execute 插件运行 ${denying.later.pre} 次（hook 返回 allow 时 ${allowingLater.later.pre} 次）`)
assert.equal(denied, '报错「Error: hook 拒绝 2.4」')
assert.equal(denying.later.pre, 0)
assert.equal(allowingLater.later.pre, 1)

const pre = (mode: string): HookSpec => ({ event: 'PreToolUse', matcher: 'deploy_release', mode })
const strictest = await boot({ hooks: [pre('allow'), pre('ask'), pre('deny')], approval: true })
const strictestResult = await deploy(strictest, '2.4')
const loose = await boot({ hooks: [pre('ask'), pre('allow')], approval: true })
const looseResult = await deploy(loose, '2.4')
log(`同一事件配 allow、ask、deny 三个 hook：依次运行 ${hookLedger(strictest).map(e => e.mode).join('、')}，结果 ${strictestResult}，审批请求 ${strictest.asks.length} 次`)
log(`配 ask、allow 两个：结果 ${looseResult}，审批请求 ${loose.asks.length} 次`)
const napping = await boot({ hooks: [pre('nap'), pre('nap')] })
await deploy(napping, '2.4')
const naps = hookLedger(napping)
const gap = (naps[1]?.at ?? 0) - (naps[0]?.at ?? 0)
log(`同一条命令配两次、各占 300 毫秒：运行 ${naps.length} 次，第二个比第一个晚开始 300 毫秒以上：${gap >= 300}`)
assert.deepEqual(hookLedger(strictest).map(e => e.mode), ['allow', 'ask', 'deny'])
assert.equal(strictestResult, '报错「Error: hook 拒绝 2.4」')
assert.equal(strictest.asks.length, 0)
assert.equal(looseResult, 'payment-api 2.4 succeeded')
assert.equal(loose.asks.length, 1)
assert.equal(naps.length, 2)
assert.ok(gap >= 300)

log('\n== 4. PostToolUse：部署已经执行，hook 只能改结果 ==')
const checked = await boot({ hooks: [{ event: 'PostToolUse', matcher: 'deploy_release', mode: 'post-check' }], rules: true })
const postResults: string[] = []
for (let i = 0; i < 3; i++) postResults.push(await deploy(checked, '2.3'))
log(`连续部署 2.3 三次，每次：${postResults[0]}`)
log(`平台执行 ${checked.platform.length} 次，规则历史 ${checked.ctx.releaseRules.history().length} 条，第 3 次守卫没有拦`)
assert.deepEqual(postResults, Array(3).fill('报错「2.3 部署失败，先查原因再重试」'))
assert.deepEqual(checked.platform, ['2.3', '2.3', '2.3'])
assert.equal(checked.ctx.releaseRules.history().length, 0)
const fine = await deploy(checked, '2.4')
log(`部署 2.4：${fine}；模型下一次请求里多了一条插件消息：${pluginMessages(checked).join(' / ')}`)
assert.equal(fine, 'payment-api 2.4 succeeded')
assert.deepEqual(pluginMessages(checked), ['2.4 已上线，记得 10 分钟后看错误率'])
const layered = await boot({ hooks: [{ event: 'PostToolUse', matcher: 'deploy_release', mode: 'post-check' }], later: 'post' })
const layeredFailed = await deploy(layered, '2.3')
const postAfterBlock = layered.later.post
const layeredFine = await deploy(layered, '2.4')
log(`后面再注册一个 post-execute 插件（对 2.4 返回 block）：`)
log(`  部署 2.3：${layeredFailed}，后面的插件运行 ${postAfterBlock} 次`)
log(`  部署 2.4：${layeredFine}，后面的插件运行 ${layered.later.post - postAfterBlock} 次；hook 的附加消息仍在：${pluginMessages(layered).join(' / ')}`)
assert.equal(layeredFailed, '报错「2.3 部署失败，先查原因再重试」')
assert.equal(postAfterBlock, 0)
assert.equal(layeredFine, '报错「值班规则：2.4 先灰度」')
assert.equal(layered.later.post - postAfterBlock, 1)
assert.deepEqual(pluginMessages(layered), ['2.4 已上线，记得 10 分钟后看错误率'])

log('\n== 5. Stop：强制继续没有上限 ==')
const smoke = await boot({ hooks: [{ event: 'Stop', mode: 'stop-smoke' }] })
await deploy(smoke, '2.4')
const steered = smoke.model.requests.flatMap(r => r.messages).filter(fromHooks).map(text)
log(`hook 自己计数、拦两次：模型请求 ${smoke.model.requests.length} 次（部署本身 2 次）`)
log(`  模型收到的引导：${[...new Set(steered)].join(' / ')}`)
const stopFlags = hookLedger(smoke).map(e => e.payload.stop_hook_active)
log(`  三次 Stop 的 stop_hook_active：${stopFlags.join(', ')}`)
assert.equal(smoke.model.requests.length, 4)
assert.deepEqual([...new Set(steered)], ['还没跑冒烟检查（第 1 次拦下）', '还没跑冒烟检查（第 2 次拦下）'])
assert.deepEqual(stopFlags, [false, false, false])

// Claude Code 文档里防循环的写法：stop_hook_active 为 true 时放行。
const looping = await boot({ hooks: [{ event: 'Stop', mode: 'stop-cc' }] })
looping.model.onRequest = (count) => { if (count === 12) looping.agent.cancel({ kind: 'user' }) }
await deploy(looping, '2.4')
const loopEnd = events(looping).findLast(e => e.type === 'turn/end')
log(`按 stop_hook_active 自我限制的 hook：Stop 运行 ${hookLedger(looping).length} 次、模型请求 ${looping.model.requests.length} 次后由 demo 取消，轮次结束原因 ${JSON.stringify(loopEnd?.type === 'turn/end' ? loopEnd.data.reason : undefined)}`)
assert.equal(looping.model.requests.length, 12)
assert.ok(hookLedger(looping).every(e => e.payload.stop_hook_active === false))

log('\n== 6. PTC 程序里的子调用、updatedInput ==')
const programmed = await boot({ hooks: [pre('freeze')], ptc: true })
programmed.model.calls.push({ name: 'run_code', args: { description: 'Deploy', code: `try { return (await tools.deploy_release({ service: 'payment-api', version: '2.4' })).outcome } catch (error) { return 'caught: ' + error.message }` } })
programmed.agent.followup(createUserMessage({ content: [{ type: 'text', text: '写程序发布 payment-api 2.4' }], source: { kind: 'user' } }))
await programmed.agent.whenIdle()
const [sub] = hookLedger(programmed)
log(`PTC 程序里调 deploy_release：程序拿到 ${lastResult(programmed)}，平台执行 ${programmed.platform.length} 次`)
log(`  hook 收到 tool_name = ${String(sub?.payload.tool_name)}，tool_use_id = ${String(sub?.payload.tool_use_id)}`)
assert.equal(lastResult(programmed), 'caught: 发布冻结中，2.4 等窗口结束再部署')
assert.equal(programmed.platform.length, 0)
assert.equal(sub?.payload.tool_name, 'deploy_release')
assert.equal(sub?.payload.tool_use_id, 'call-1:ptc:1')

const rewriting = await boot({ hooks: [pre('rewrite')] })
const rewritten = await deploy(rewriting, '2.4')
const ignored = rewriting.logs.filter(t => t.includes('updatedInput'))
log(`hook 放行并要求把版本改成 2.5：${rewritten}，平台收到 ${rewriting.platform.join(', ')}`)
log(`  logger：${ignored.join(' / ')}`)
assert.equal(rewritten, 'payment-api 2.4 succeeded')
assert.deepEqual(rewriting.platform, ['2.4'])
assert.deepEqual(ignored, ['hooks-claude-code: PreToolUse hook requested updatedInput, which is not yet honored (ignored)'])

await Promise.all([frozen, control, asking, allowing, hookFirst, freezeFirst, denying, allowingLater, strictest, loose, napping, checked, layered, smoke, looping, programmed, rewriting].map(host => host.ctx.fiber.dispose()))
