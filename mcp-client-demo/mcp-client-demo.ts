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
import { ReleaseRules, failedTwiceIn24h, rulePlugin, type Config as RulesConfig } from './release-rules.ts'

const log = (msg: string) => { console.log(msg) }
const base = mkdtempSync(join(tmpdir(), 'dsh-mcp-client-'))
process.on('exit', () => { rmSync(base, { recursive: true, force: true }) })
const SERVER = fileURLToPath(new URL('./release-mcp-server.mjs', import.meta.url))
const MCP_DEPLOY = 'mcp__release__deploy_release'
const now = Date.UTC(2026, 8, 28, 1)
// 宿主进程里有一个凭据形的环境变量（假值），看它会不会传给 MCP 服务器。
process.env.RELEASE_API_TOKEN = 'demo-token'

// ── 脚本化模型：每轮调一次工具，看到工具结果后回一句话 ─────────────────────────────
interface Call { name: string; args: object }
class ScriptedModel extends LlmAdapter {
  readonly calls: Call[] = []
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
  approval?: boolean
  env?: Record<string, string>
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
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const asks: string[] = []
  if (options.approval === true) {
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    // 脚本化的审批人：每次都批准。
    ctx.on('approval/request', (req) => {
      asks.push(req.callId ?? '-')
      return Promise.resolve('allowed-once')
    })
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
  })
  const model = new ScriptedModel()
  ctx.llm.registerAdapter(['scripted'], model)
  const { agent } = await ctx.agents.create({ sessionId: SessionId(`host-${hosts}`), agentOptions: { provider: 'scripted', model: 'mock' } })
  return { ctx, model, agent, ledger, asks, logs }
}
async function deploy(host: Host, version: unknown, name = MCP_DEPLOY): Promise<string> {
  host.model.calls.push({ name, args: { service: 'payment-api', version } })
  host.agent.followup(createUserMessage({ content: [{ type: 'text', text: `发布 payment-api ${String(version)}` }], source: { kind: 'user' } }))
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
type LedgerEntry = { event: string; token?: string; version?: string; outcome?: string }
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
const system = systemText(request.messages.find(m => m.role === 'system'))
const section = system.slice(system.indexOf('### MCP server'))
log('系统提示里多了一段，服务器给的 instructions 原样拼在后面：')
for (const line of section.split('\n').filter(Boolean)) log(`  ${line}`)
const handshake = ledgerOf(plain).slice(0, 5).map(e => e.event)
log(`一次连接启动服务器进程 ${count(plain, 'start')} 次：${handshake.join(' → ')}`)
log(`宿主进程有 RELEASE_API_TOKEN，服务器进程里：${ledgerOf(plain).map(e => e.token).filter(Boolean).join('、')}`)
assert.deepEqual(request.tools?.map(t => t.name), [MCP_DEPLOY])
assert.deepEqual(Object.keys(schema).sort(), ['description', 'name', 'parameters'])
assert.deepEqual(schema.parameters, serverSchema)
assert.equal(section, '### MCP server: release\n\nAlways look up the latest release before deploying.')
assert.deepEqual(handshake, ['start', 'server/discover', 'start', 'initialize', 'tools/list'])
assert.deepEqual(ledgerOf(plain).map(e => e.token).filter(Boolean), ['absent', 'absent'])

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
const adapted = await boot({ rules: STRUCTURED, approval: true })
const outcomes: string[] = []
for (let i = 0; i < 3; i++) outcomes.push(await deploy(adapted, '2.3'))
log(`再从 structuredContent 读结果：${firstEntry(adapted)}`)
log(`  第 3 次：${outcomes[2]}`)
log(`  审批人收到 ${adapted.asks.length} 次请求、都批准了；第 3 次批准后才被守卫拒绝`)
assert.equal(count(adapted, 'deploy'), 2)
assert.equal(adapted.ctx.releaseRules.history().length, 2)
assert.equal(outcomes[2], '报错「Error: [same-version-failed-twice] payment-api 2.3 在 24 小时内已失败 2 次，停止重试」')
assert.deepEqual(adapted.asks, ['call-1', 'call-2', 'call-3'])

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
const crashy = await boot({ env: { RELEASE_API_TOKEN: 'demo-token' } })
log(`env 里显式传入后，服务器进程里：${ledgerOf(crashy).map(e => e.token).filter(Boolean).join('、')}`)
const before = crashy.ctx.tools.get(MCP_DEPLOY)
const crashed = await deploy(crashy, '2.6')
const crashDeploy = ledgerOf(crashy).findLast(e => e.event === 'deploy')
log(`部署 2.6：${crashed}`)
log(`  平台账本里这次部署已经执行：${crashDeploy?.version} ${crashDeploy?.outcome}`)
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

for (const host of [plain, byName, renamed, adapted, typed, crashy]) await host.ctx.fiber.dispose()
