/** Put the synthetic release platform behind a local MCP server and see what dsh-mcp-client registers, and how rules, approval and reconnects treat it. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
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
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as checkpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import PtcRuntimeNode from '@deepseek-ai/dsh-ptc-runtime-node'
import { ReleaseRules, failedTwiceIn24h, rulePlugin, type Config as RulesConfig } from './release-rules.ts'
import { readDeploys } from './log-miner.ts'

const log = (msg: string) => { console.log(msg) }
const base = mkdtempSync(join(tmpdir(), 'dsh-mcp-client-'))
process.on('exit', () => { rmSync(base, { recursive: true, force: true }) })
const SERVER = fileURLToPath(new URL('./release-mcp-server.mjs', import.meta.url))
const MCP_DEPLOY = 'mcp__release__deploy_release'
const sessionLogs = join(base, 'sessions')
const now = Date.UTC(2026, 8, 28, 1)
// 宿主进程里有一个凭据形的环境变量（假值），看它会不会传给 MCP 服务器。
process.env.RELEASE_API_TOKEN = 'demo-token'
// 再放一个 DSH_ 开头、名字不像凭据的变量，看它会不会传过去。
process.env.DSH_DEMO_MARKER = 'on'

// ── 脚本化模型：每轮调一次工具，看到工具结果后回一句话 ─────────────────────────────
interface Call { name: string; args: object }
class ScriptedModel extends LlmAdapter {
  // 一项是一条回复：单个调用，或同一条消息里的多个调用。
  readonly calls: (Call | Call[])[] = []
  readonly requests: GenerateOptions[] = []
  private seq = 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
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
  private toolCall(calls: Call | Call[]): StreamChunk[] {
    return [
      ...[calls].flat().flatMap((call, index): StreamChunk[] => {
        const id = ToolCallId(`call-${++this.seq}`)
        const json = JSON.stringify(call.args)
        return [
          { type: 'block-start', index, blockType: 'tool-call' },
          { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: json },
          { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: json } },
        ]
      }),
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
  }
}

// ── 本地的同名工具，用来和 MCP 工具对照参数校验 ──────────────────────────────────
let localDeploys = 0
const localDeploy = defineTool({
  name: 'deploy_release',
  description: 'Deploy one version of a service to the synthetic release platform.',
  parameters: { service: { type: 'string', required: true }, version: { type: 'string', required: true } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute(args) {
    localDeploys++
    return Promise.resolve(`${args.service} ${args.version} succeeded`)
  },
})

// ── 宿主 ───────────────────────────────────────────────────────────────
interface HostOptions {
  rules?: RulesConfig
  /** true：审批服务 + 对 MCP 部署返回 ask；'service'：只挂审批服务。 */
  approval?: boolean | 'service'
  env?: Record<string, string>
  /** 会话日志写进 JSONL，供第 23 篇的 readDeploys 读。 */
  persist?: boolean
  /** tools 用 PTC 模式，挂 PTC 进程运行时（第 25 篇同款）。 */
  ptc?: boolean
  /** 额外的 mcp-client 配置。 */
  mcp?: { maxInstructionBytes?: number; toolCallTimeoutMs?: number }
}
interface Host { ctx: Context; model: ScriptedModel; agent: Agent; ledger: string; asks: string[]; logs: string[] }
let hosts = 0
async function boot(options: HostOptions = {}): Promise<Host> {
  const ctx = new Context()
  // mcp-client 的重连决定只写进 cordis 的 logger，其中重试用的是 warn；收下所有级别的消息。
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (m) => { logs.push(String(m.args[0])) } })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, options.ptc === true ? { mode: 'ptc' } : {})
  await ctx.plugin(AgentRegistry)
  if (options.persist === true) {
    await ctx.plugin(JsonlSessionPersistence, { root: sessionLogs, compression: 'none' })
    await ctx.plugin(checkpointPolicy)
  }
  if (options.ptc === true) {
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: base })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: base })
    await ctx.plugin(PtcRuntimeNode)
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  const asks: string[] = []
  if (options.approval !== undefined && options.approval !== false) {
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    // 脚本化的审批人：每次都批准。
    ctx.on('approval/request', (req) => {
      asks.push(req.callId ?? '-')
      return Promise.resolve('allowed-once')
    })
  }
  if (options.approval === true) {
    ctx.on('tools/pre-execute', (exec, next) => exec.name === MCP_DEPLOY
      ? Promise.resolve({ kind: 'ask', reason: '部署要人工确认' } as const)
      : next())
  }
  if (options.rules !== undefined) {
    await ctx.plugin(ReleaseRules, { ...options.rules, now: () => now })
    await ctx.plugin(rulePlugin(failedTwiceIn24h))
  }
  const ledger = join(base, `ledger-${++hosts}.jsonl`)
  writeFileSync(ledger, '')
  // 重连策略：默认 500 毫秒起步、上限 30 秒、最多 10 次；这里缩短，让 demo 几秒内跑完。
  // maxDelayMs 同时是稳定窗口：连接保持超过它，下一次断开才重新计数。
  await ctx.plugin(McpClient, {
    transport: 'stdio',
    serverName: 'release',
    command: process.execPath,
    args: [SERVER, ledger],
    env: options.env ?? {},
    reconnect: { initialDelayMs: 20, maxDelayMs: 1000, maxAttempts: 3 },
    ...options.mcp,
  })
  const model = new ScriptedModel()
  ctx.llm.registerAdapter(['scripted'], model)
  const { agent } = await ctx.agents.create({ sessionId: SessionId(`host-${hosts}`), agentOptions: { provider: 'scripted', model: 'mock' } })
  return { ctx, model, agent, ledger, asks, logs }
}
async function deploy(host: Host, version: unknown, name = MCP_DEPLOY): Promise<string> {
  return turn(host, `发布 payment-api ${String(version)}`, { name, args: { service: 'payment-api', version } })
}
async function turn(host: Host, text: string, calls: Call | Call[]): Promise<string> {
  host.model.calls.push(calls)
  host.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
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
type LedgerEntry = { event: string; token?: string; dsh?: string; version?: string; outcome?: string }
const ledgerOf = (host: Host): LedgerEntry[] => readFileSync(host.ledger, 'utf8').split('\n').filter(Boolean)
  .map(line => JSON.parse(line) as LedgerEntry)
const count = (host: Host, event: string) => ledgerOf(host).filter(e => e.event === event).length
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return
    await sleep(10)
  }
  assert.fail(`timed out waiting for ${what}`)
}
const supervisorLog = (host: Host) => host.logs
  .filter(text => /reconnecting in|retrying in|reconnected|giving up/.test(text))
  .map(text => text.replace('mcp-client(release): ', '').replace(/ — .*/, ''))
const systemText = (message: Message | undefined) => (message?.content ?? []).map(b => b.type === 'text' ? b.text : '').join('')

log('== 1. 接入后，注册表和模型看到什么 ==')
const plain = await boot()
await deploy(plain, '2.4')
const request = plain.model.requests[0]
assert.ok(request)
const schema = request.tools?.find(t => t.name === MCP_DEPLOY)
assert.ok(schema)
log(`模型拿到的工具：${request.tools?.map(t => t.name).join(', ')}`)
log(`工具 schema 的字段：${Object.keys(schema).sort().join(', ')}`)
const serverSchema = { type: 'object', properties: { service: { type: 'string' }, version: { type: 'string' } }, required: ['service', 'version'] }
log(`parameters 与服务器的 inputSchema 相同：${String(JSON.stringify(schema.parameters) === JSON.stringify(serverSchema))}`)
log('服务器声明的 annotations（destructiveHint）和 outputSchema 没有交给模型')
const odd = await boot({ env: { RELEASE_ODD_NAMES: '1' } })
await until(() => odd.ctx.tools.schemas().some(t => t.name.startsWith('mcp__release__')), 'the odd-name sync')
const oddNames = odd.ctx.tools.schemas().map(t => t.name).filter(n => n.startsWith('mcp__release__')).sort()
log('服务器另报两个名字不合规的工具 deploy.release 和 deploy_x…x（67 个字符）：')
for (const name of oddNames) log(`  ${name}（${name.length} 个字符）`)
const approvalOnly = await boot({ approval: 'service' })
const destructive = await deploy(approvalOnly, '2.4')
log(`只挂审批服务、不配 ask 规则：审批请求 ${approvalOnly.asks.length} 次，部署直接执行：${destructive}`)
const sequential = await boot()
const definition = sequential.ctx.tools.get(MCP_DEPLOY)
await turn(sequential, '一次发两个', [{ name: MCP_DEPLOY, args: { service: 'payment-api', version: '2.8' } }, { name: MCP_DEPLOY, args: { service: 'order-api', version: '2.8' } }])
const order = ledgerOf(sequential).filter(e => e.event === 'deploy' || e.event === 'reply').map(e => e.event)
log(`工具定义的 isConcurrencySafe：${String(definition?.isConcurrencySafe)}；一条消息两个调用（每个 300 毫秒），服务器上：${order.join(' → ')}`)
const system = systemText(request.messages.find(m => m.role === 'system'))
const section = system.slice(system.indexOf('### MCP server'))
log('系统提示里多了一段，服务器给的 instructions 原样拼在后面：')
for (const line of section.split('\n').filter(Boolean)) log(`  ${line}`)
const handshake = ledgerOf(plain).slice(0, 5).map(e => e.event)
log(`一次连接启动服务器进程 ${count(plain, 'start')} 次：${handshake.join(' → ')}`)
log(`宿主进程有 RELEASE_API_TOKEN，服务器进程里：${ledgerOf(plain).map(e => e.token).filter(Boolean).join('、')}`)
log(`宿主进程有 DSH_DEMO_MARKER，服务器进程里：${ledgerOf(plain).map(e => e.dsh).filter(Boolean).join('、')}`)
const wordy = await boot({ mcp: { maxInstructionBytes: 10 } })
await until(() => wordy.logs.some(t => t.includes('giving up')), 'the instructions give-up')
const wordyLog = wordy.logs.filter(t => /exceed|retrying in|giving up/.test(t)).map(t => t.replace('mcp-client(release): ', '').replace(/ — .*/, ''))
log('maxInstructionBytes 设成 10：')
for (const line of wordyLog) log(`  ${line}`)
log(`  服务器进程启动 ${count(wordy, 'start')} 次，注册的 MCP 工具 ${wordy.ctx.tools.schemas().filter(t => t.name.startsWith('mcp__')).length} 个`)
assert.deepEqual(request.tools?.map(t => t.name), [MCP_DEPLOY])
assert.deepEqual(Object.keys(schema).sort(), ['description', 'name', 'parameters'])
assert.deepEqual(schema.parameters, serverSchema)
assert.equal(oddNames.length, 3)
assert.ok(oddNames.includes(MCP_DEPLOY))
assert.ok(oddNames.filter(n => n !== MCP_DEPLOY).every(n => /_[0-9a-f]{12}$/.test(n)))
assert.ok(oddNames.some(n => n.startsWith('mcp__release__deploy_release_') && n.length === 41))
assert.ok(oddNames.some(n => n.length === 64))
assert.equal(approvalOnly.asks.length, 0)
assert.equal(destructive, 'payment-api 2.4 succeeded')
assert.equal(definition?.isConcurrencySafe, undefined)
assert.deepEqual(order, ['deploy', 'reply', 'deploy', 'reply'])
assert.equal(section, '### MCP server: release\n\nAlways look up the latest release before deploying.')
assert.deepEqual(handshake, ['start', 'server/discover', 'start', 'initialize', 'tools/list'])
assert.deepEqual(ledgerOf(plain).map(e => e.token).filter(Boolean), ['absent', 'absent'])
assert.deepEqual(ledgerOf(plain).map(e => e.dsh).filter(Boolean), ['absent', 'absent'])
assert.equal(wordyLog.filter(t => t.includes('exceed maxInstructionBytes (10)')).length, 4)
assert.equal(wordyLog.at(-1), 'giving up after 3 consecutive failed reconnect attempts')
assert.equal(count(wordy, 'start'), 8)
assert.equal(wordy.ctx.tools.schemas().filter(t => t.name.startsWith('mcp__')).length, 0)

log('\n== 2. 第 21 篇的规则引擎：连续部署 2.3 三次 ==')
const firstEntry = (host: Host) => {
  const history = host.ctx.releaseRules.history().length
  return `平台执行 ${count(host, 'deploy')} 次，规则历史 ${history} 条`
}
const byName = await boot({ rules: {} })
for (let i = 0; i < 3; i++) await deploy(byName, '2.3')
log(`默认配置（认 deploy_release）：${firstEntry(byName)}`)
assert.equal(count(byName, 'deploy'), 3)
assert.equal(byName.ctx.releaseRules.history().length, 0)

let valueKeys = ''
const renamed = await boot({ rules: { deployTool: MCP_DEPLOY } })
renamed.ctx.on('tools/result', (exec, result) => {
  if (exec.name === MCP_DEPLOY && !result.isError) valueKeys = Object.keys(result.value as object).join('、')
  return undefined
})
for (let i = 0; i < 3; i++) await deploy(renamed, '2.3')
log(`deployTool 改成 MCP 名：${firstEntry(renamed)}`)
log(`  结果值的字段是 ${valueKeys}，引擎读 value.outcome 读不到`)
assert.equal(count(renamed, 'deploy'), 3)
assert.equal(renamed.ctx.releaseRules.history().length, 0)
assert.equal(valueKeys, 'content、structuredContent')

const STRUCTURED: RulesConfig = {
  deployTool: MCP_DEPLOY,
  outcomeOf: value => (value as { structuredContent?: { outcome?: unknown } } | null)?.structuredContent?.outcome,
}
const adapted = await boot({ rules: STRUCTURED, approval: true, persist: true })
const outcomes: string[] = []
for (let i = 0; i < 3; i++) outcomes.push(await deploy(adapted, '2.3'))
log(`再从 structuredContent 读结果：${firstEntry(adapted)}`)
log(`  第 3 次：${outcomes[2]}`)
log(`  审批人收到 ${adapted.asks.length} 次请求、都批准了；第 3 次批准后才被守卫拒绝`)
assert.equal(count(adapted, 'deploy'), 2)
assert.equal(adapted.ctx.releaseRules.history().length, 2)
assert.equal(outcomes[2], '报错「Error: [same-version-failed-twice] payment-api 2.3 在 24 小时内已失败 2 次，停止重试」')
assert.deepEqual(adapted.asks, ['call-1', 'call-2', 'call-3'])
await adapted.ctx.fiber.dispose()
const reader = new Context()
await reader.plugin(SessionStore)
await reader.plugin(SessionProjectionRegistry)
await reader.plugin(JsonlSessionPersistence, { root: sessionLogs, compression: 'none' })
await reader.plugin(SqliteSessionQueryEngine, { path: join(base, 'session-search.db') })
const byOldName = await readDeploys(reader, 'deploy_release')
const byMcpName = await readDeploys(reader, MCP_DEPLOY)
log(`第 23 篇的 readDeploys 读这台宿主的日志：按 deploy_release 读回 ${byOldName.length} 条；按 MCP 名读回 ${byMcpName.length} 条（${byMcpName.map(r => r.kind).join('、')}）`)
log(`  读回的记录里 service/version/outcome：${byMcpName.every(r => r.service === undefined && r.version === undefined && r.outcome === undefined) ? '都没有' : '有'}，tool/result 没有 meta：${byMcpName.every(r => !r.dataKeys.includes('meta'))}`)
assert.equal(byOldName.length, 0)
assert.deepEqual(byMcpName.map(r => r.kind), ['executed', 'executed', 'error'])
assert.ok(byMcpName.every(r => r.service === undefined && r.version === undefined && r.outcome === undefined))
assert.ok(byMcpName.every(r => !r.dataKeys.includes('meta')))
await reader.fiber.dispose()

log('\n== 3. 参数不经 dsh 校验：version 传成数字 2.3 ==')
const typed = await boot({ rules: STRUCTURED })
typed.ctx.tools.register(localDeploy)
for (let i = 0; i < 2; i++) await deploy(typed, '2.3')
const local = await deploy(typed, 2.3, 'deploy_release')
log(`本地 deploy_release：${local}，执行 ${localDeploys} 次`)
const remote = await deploy(typed, 2.3)
const lastDeploy = ledgerOf(typed).findLast(e => e.event === 'deploy')
log(`MCP 工具：守卫放行，服务器把它转成 "${lastDeploy?.version}" 部署，结果 ${remote}`)
log(`规则历史仍是 ${typed.ctx.releaseRules.history().length} 条，平台上 2.3 已失败 ${count(typed, 'deploy')} 次`)
assert.equal(local, '报错「Error: invalid arguments: "version" must be a string」')
assert.equal(localDeploys, 0)
assert.equal(remote, 'payment-api 2.3 failed')
assert.equal(typed.ctx.releaseRules.history().length, 2)
assert.equal(count(typed, 'deploy'), 3)

log('\n== 4. 服务器在回复前崩溃，之后重连 ==')
const crashy = await boot({ env: { RELEASE_API_TOKEN: 'demo-token' }, rules: STRUCTURED })
log(`env 里显式传入后，服务器进程里：${ledgerOf(crashy).map(e => e.token).filter(Boolean).join('、')}`)
const before = crashy.ctx.tools.get(MCP_DEPLOY)
const crashed = await deploy(crashy, '2.6')
const crashDeploy = ledgerOf(crashy).findLast(e => e.event === 'deploy')
const crashHistory = crashy.ctx.releaseRules.history().length
log(`部署 2.6：${crashed}`)
log(`  平台账本里这次部署已经执行：${crashDeploy?.version} ${crashDeploy?.outcome}；规则历史 ${crashHistory} 条`)
const during = await deploy(crashy, '2.4')
log(`紧接着再部署：${during}`)
await until(() => crashy.ctx.tools.get(MCP_DEPLOY) !== before && crashy.ctx.tools.get(MCP_DEPLOY) !== undefined, 'the reconnect re-sync')
const after = await deploy(crashy, '2.4')
log('重连日志：')
for (const line of supervisorLog(crashy)) log(`  ${line}`)
log(`重连后工具换成新一代定义，再部署：${after}`)
log(`服务器进程累计启动 ${count(crashy, 'start')} 次`)
assert.deepEqual(ledgerOf(crashy).map(e => e.token).filter(Boolean).slice(0, 2), ['present', 'present'])
assert.equal(crashed, '报错「Error: Connection closed」')
assert.equal(crashHistory, 0)
assert.deepEqual(ledgerOf(crashy).filter(e => e.event === 'deploy').map(e => e.version), ['2.6', '2.4'])
assert.equal(during, '报错「Error: Not connected」')
assert.equal(after, 'payment-api 2.4 succeeded')
assert.equal(count(crashy, 'start'), 4)
assert.deepEqual(supervisorLog(crashy), ['connection lost; reconnecting in 20ms (attempt 1/3)', 'reconnected and re-synced tools (attempt 1/3)'])

writeFileSync(`${crashy.ledger}.down`, '')
await deploy(crashy, '2.6')
await until(() => crashy.ctx.tools.get(MCP_DEPLOY) === undefined, 'the give-up')
const gaveUp = supervisorLog(crashy).slice(2)
const gone = await deploy(crashy, '2.4')
const tools = crashy.model.requests.at(-2)?.tools?.map(t => t.name) ?? []
log('平台起不来，1 秒内再崩溃一次：')
for (const line of gaveUp) log(`  ${line}`)
log(`工具被移出注册表；模型下一次请求的工具列表：[${tools.join(', ')}]`)
log(`再调：${gone}`)
assert.deepEqual(gaveUp, [
  'connection lost; reconnecting in 40ms (attempt 2/3)',
  'connection failed; retrying in 80ms (attempt 3/3)',
  'giving up after 3 consecutive failed reconnect attempts',
])
assert.deepEqual(tools, [])
assert.equal(gone, '报错「Error: unknown tool "mcp__release__deploy_release"」')
const startsAtGiveUp = count(crashy, 'start')
await sleep(1500)
log(`放弃后等 1.5 秒（超过重连上限 1 秒）：服务器进程启动次数 ${startsAtGiveUp} → ${count(crashy, 'start')}，工具仍${crashy.ctx.tools.get(MCP_DEPLOY) === undefined ? '不在' : '在'}注册表里`)
const buffered = crashy.ctx.logger.buffer.map(m => String(m.args[0])).filter(t => /reconnecting in|retrying in|reconnected|giving up/.test(t))
  .map(t => t.replace('mcp-client(release): ', '').replace(/ — .*/, '').replace(/ in \d+ms.*/, ''))
log(`logger 默认缓冲（不设级别）里留下的重连记录：${buffered.join('；')}`)
assert.equal(count(crashy, 'start'), startsAtGiveUp)
assert.equal(crashy.ctx.tools.get(MCP_DEPLOY), undefined)
assert.deepEqual(buffered, ['reconnected and re-synced tools (attempt 1/3)', 'giving up after 3 consecutive failed reconnect attempts'])

log('\n== 5. PTC 程序调 MCP 工具、服务器改工具列表、调用超时 ==')
const programmed = await boot({ ptc: true })
const program = `const r = await tools.${MCP_DEPLOY}({ service: 'payment-api', version: '2.4' })\nreturn JSON.stringify(r)`
const fromProgram = await turn(programmed, '写程序发布 payment-api 2.4', { name: 'run_code', args: { code: program, description: 'Deploy' } })
log(`PTC 程序里调 ${MCP_DEPLOY}，程序拿到的值：`)
log(`  ${fromProgram}`)
assert.equal(fromProgram, JSON.stringify({ content: [{ type: 'text', text: 'payment-api 2.4 succeeded' }], structuredContent: { service: 'payment-api', version: '2.4', outcome: 'succeeded' } }))
assert.equal(count(programmed, 'deploy'), 1)

const changing = await boot({ env: { RELEASE_LIST_CHANGE: '1' } })
const ROLLBACK = 'mcp__release__rollback_release'
const beforeChange = changing.ctx.tools.schemas().filter(t => t.name.startsWith('mcp__')).map(t => t.name)
await deploy(changing, '2.4')
await until(() => changing.ctx.tools.get(ROLLBACK) !== undefined, 'the list_changed re-sync')
await deploy(changing, '2.5')
const nextTools = changing.model.requests.at(-2)?.tools?.map(t => t.name) ?? []
log(`服务器在第一次部署后发 tools/list_changed：工具 ${beforeChange.join(', ')} → 下一次模型请求里 ${nextTools.join(', ')}`)
log(`  服务器进程启动 ${count(changing, 'start')} 次，tools/list 收到 ${count(changing, 'tools/list')} 次`)
assert.deepEqual(beforeChange, [MCP_DEPLOY])
assert.deepEqual(nextTools, [MCP_DEPLOY, ROLLBACK])
assert.equal(count(changing, 'start'), 2)
assert.equal(count(changing, 'tools/list'), 2)
assert.ok(changing.logs.some(t => t.includes('tool list changed, re-syncing')))

const hurried = await boot({ mcp: { toolCallTimeoutMs: 100 } })
const timedOut = await deploy(hurried, '2.8')
await until(() => count(hurried, 'reply') === 1, 'the late reply')
log(`toolCallTimeoutMs 设成 100，服务器 300 毫秒后才回：${timedOut}`)
log(`  平台账本：${ledgerOf(hurried).filter(e => e.event === 'deploy' || e.event === 'reply').map(e => `${e.event} ${e.version}`).join(' → ')}`)
assert.match(timedOut, /^报错「/)
assert.deepEqual(ledgerOf(hurried).filter(e => e.event === 'deploy' || e.event === 'reply').map(e => e.event), ['deploy', 'reply'])

for (const host of [plain, odd, approvalOnly, sequential, wordy, byName, renamed, typed, crashy, programmed, changing, hurried]) await host.ctx.fiber.dispose()
