/** Deploy tools under dsh's cooperative timeout policy and the repeat-call reminder: what times out, what still happens on the platform, and which loops get a nudge. */
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as TimeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'
import * as RepeatReminder from '@deepseek-ai/dsh-repeat-tool-reminder'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import * as toolBash from '@deepseek-ai/dsh-tool-bash'
import * as toolWeb from '@deepseek-ai/dsh-tool-web'

const log = (msg: string) => { console.log(msg) }

// ── 脚本化模型：按剧本调工具，剧本用完就回一句话 ─────────────────────────────────
interface Call { name: string; args: object }
class ScriptedModel extends LlmAdapter {
  // 一个元素是一步；数组表示同一步里并发的几个调用。
  readonly calls: (Call | Call[])[] = []
  readonly requests: GenerateOptions[] = []
  private seq = 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const call = this.calls.shift()
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
  private toolCall(step: Call | Call[]): StreamChunk[] {
    const blocks = (Array.isArray(step) ? step : [step]).flatMap((call, index): StreamChunk[] => {
      const id = ToolCallId(`call-${++this.seq}`)
      const json = JSON.stringify(call.args)
      return [
        { type: 'block-start', index, blockType: 'tool-call' },
        { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: json },
        { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: json } },
      ]
    })
    return [
      ...blocks,
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
  }
}

// ── 合成发布平台：收到部署请求就开始，ROLLOUT_MS 后上线；取消等待不会撤回部署 ──────────
const ROLLOUT_MS = 2500
const TIMEOUT_MS = 1000
const started = Date.now()
const at = () => Date.now() - started
const platform = { requests: [] as string[], live: [] as string[] }
function rollout(version: string): Promise<void> {
  platform.requests.push(version)
  return sleep(ROLLOUT_MS).then(() => { platform.live.push(version) })
}
const text = { type: 'string' } as const
const render = (_args: unknown, value: string) => [{ type: 'text' as const, text: value }]

// 按约定转发 exec.signal：超时后不再等平台确认，但请求已经发出去了。
const deploy = defineTool({
  name: 'deploy_release',
  description: 'Deploy one version and wait for the platform to confirm.',
  parameters: { service: { type: 'string', required: true }, version: { type: 'string', required: true } },
  timeoutMs: TIMEOUT_MS,
  output: { schema: text, render },
  async execute(args, exec) {
    const done = rollout(args.version)
    await Promise.race([done, new Promise((_resolve, reject) => {
      exec.signal.addEventListener('abort', () => { reject(new Error('deploy wait aborted')) }, { once: true })
    })])
    return `${args.service} ${args.version} 已上线`
  },
})
// 声明了 timeoutMs，却不理 exec.signal。
const legacyDeploy = defineTool({
  name: 'deploy_release_legacy',
  description: 'Deploy through the old pipeline.',
  parameters: { service: { type: 'string', required: true }, version: { type: 'string', required: true } },
  timeoutMs: TIMEOUT_MS,
  output: { schema: text, render },
  async execute(args) {
    await rollout(args.version)
    return `${args.service} ${args.version} 已上线`
  },
})
// 没声明 timeoutMs 的慢工具。
const slowDashboard = defineTool({
  name: 'read_dashboard',
  description: 'Read the service dashboard.',
  parameters: {},
  output: { schema: text, render },
  async execute() {
    await sleep(ROLLOUT_MS)
    return 'error rate 0.1%'
  },
})
let statusCalls = 0
const status = defineTool({
  name: 'check_status',
  description: 'Check the rollout status of one version.',
  parameters: { service: { type: 'string', required: true }, version: { type: 'string', required: true } },
  output: { schema: text, render },
  execute: () => {
    statusCalls += 1
    return Promise.resolve('rolling out')
  },
})

// ── 宿主：基础组合里的两个 guard 插件，repeat-tool-reminder 用发行版的配置 ──────────
const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(TimeoutPolicy)
// 挂在超时包装里面，记下注册表交回给超时插件的原始结果。
const inner: string[] = []
ctx.on('tools/execute', async (_exec, next) => {
  const result = await next()
  inner.push(result.content.map(c => c.type === 'text' ? c.text : '').join(''))
  return result
})
await ctx.plugin(RepeatReminder, { thresholds: [3, 5, 8], argumentsPreviewChars: 500 })
// 值班平台拒绝一切回滚；check_job 第 2 次调用时，模拟后台任务往会话里发一条 plugin 来源的通知。
ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'rollback_release'
  ? { kind: 'deny', reason: 'rollback needs the duty lead' }
  : await next())
let rollbackBodies = 0
const rollback = defineTool({
  name: 'rollback_release',
  description: 'Roll back to one version.',
  parameters: { service: { type: 'string', required: true }, version: { type: 'string', required: true } },
  output: { schema: text, render },
  execute: () => { rollbackBodies += 1; return Promise.resolve('rolled back') },
})
let jobCalls = 0
const job = defineTool({
  name: 'check_job',
  description: 'Check the smoke-test job.',
  parameters: { job: { type: 'string', required: true } },
  output: { schema: text, render },
  execute: (_args, exec) => {
    jobCalls += 1
    if (jobCalls === 2) exec.agent?.inject(createUserMessage({ content: [{ type: 'text', text: '后台任务 smoke-2.7 已完成' }], source: { kind: 'plugin', plugin: 'jobs' } }))
    return Promise.resolve('running')
  },
})
const noteTool = defineTool({
  name: 'note_progress',
  description: 'Write one progress note.',
  parameters: { text: { type: 'string', required: true } },
  output: { schema: text, render },
  execute: () => Promise.resolve('noted'),
})
for (const tool of [deploy, legacyDeploy, slowDashboard, status, rollback, job, noteTool]) ctx.tools.register(tool)
const model = new ScriptedModel()
ctx.llm.registerAdapter(['scripted'], model)
const agentOptions = { provider: 'scripted', model: 'mock' }

// ── 工具函数 ────────────────────────────────────────────────────────────────
const events = (agent: Agent): readonly SessionEvent[] => agent.session.snapshotEvents()
const blockText = (message: Message) => message.content.map(b => b.type === 'text' ? b.text : '').join('')
function results(agent: Agent): { text: string; error?: unknown }[] {
  return events(agent).flatMap((e) => {
    if (e.type !== 'tool/result') return []
    const [block] = e.data.message.content
    return [{ text: block.content.map(c => c.type === 'text' ? c.text : '').join(''), error: e.data.error }]
  })
}
let sessions = 0
async function turn(words: string, ...calls: (Call | Call[])[]): Promise<{ agent: Agent; requests: GenerateOptions[]; ms: number }> {
  const { agent } = await ctx.agents.create({ sessionId: SessionId(`duty-${String(++sessions)}`), agentOptions })
  return await more(agent, words, ...calls)
}
async function more(agent: Agent, words: string, ...calls: (Call | Call[])[]): Promise<{ agent: Agent; requests: GenerateOptions[]; ms: number }> {
  const before = model.requests.length
  const t0 = at()
  model.calls.push(...calls)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: words }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return { agent, requests: model.requests.slice(before), ms: at() - t0 }
}
/** Reminder texts first visible in each request of a turn, by request index. */
function reminders(requests: GenerateOptions[]): { request: number; text: string }[] {
  const seen = new Set<string>()
  const found: { request: number; text: string }[] = []
  requests.forEach((request, index) => {
    for (const message of request.messages) {
      if (message.source.kind !== 'plugin' || (message.source as { plugin?: string }).plugin !== 'repeat-tool-reminder' || seen.has(message.id)) continue
      seen.add(message.id)
      found.push({ request: index + 1, text: blockText(message) })
    }
  })
  return found
}
const secs = (ms: number) => `${(Math.round(ms / 100) / 10).toFixed(1)} 秒`
const call = (name: string, args: object = {}): Call => ({ name, args })
const release = (version: string) => ({ service: 'payment-api', version })

log('== 1. 转发 signal 的部署工具：1 秒超时，平台照样上线 ==')
const cooperative = await turn('发布 payment-api 2.5', call('deploy_release', release('2.5')))
const [coopResult] = results(cooperative.agent)
log(`  工具结果 | ${String(coopResult?.text)}`)
log(`  日志里的 error | ${JSON.stringify(coopResult?.error)}`)
log(`  这一轮用时 ${secs(cooperative.ms)}；此刻平台：请求 ${JSON.stringify(platform.requests)}，已上线 ${JSON.stringify(platform.live)}`)
assert.equal(coopResult?.text, 'Error: tool call timed out after 1000ms')
assert.deepEqual(coopResult?.error, { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' })
assert.ok(cooperative.ms < 2000)
assert.equal(platform.live.length, 0)
await sleep(ROLLOUT_MS)
log(`  ${secs(ROLLOUT_MS)}后平台：已上线 ${JSON.stringify(platform.live)}`)
assert.deepEqual(platform.live, ['2.5'])

log('\n== 2. 不理 signal 的部署工具和没声明超时的工具 ==')
const legacy = await turn('用旧流水线发 2.6', call('deploy_release_legacy', release('2.6')))
log(`  deploy_release_legacy（声明 1000ms，不理 signal）| 用时 ${secs(legacy.ms)} | ${String(results(legacy.agent)[0]?.text)}`)
log(`    平台此刻已上线 ${JSON.stringify(platform.live)}`)
log(`    超时插件收到的原始结果 | ${String(inner.at(-1))}`)
assert.equal(inner.at(-1), 'Error: tool call aborted')
// 定时器可能比墙钟早触发几毫秒，留一点余量。
assert.ok(legacy.ms >= ROLLOUT_MS - 50)
assert.equal(results(legacy.agent)[0]?.text, 'Error: tool call timed out after 1000ms')
assert.ok(platform.live.includes('2.6'))
const dashboard = await turn('看一下监控', call('read_dashboard'))
log(`  read_dashboard（没声明）                     | 用时 ${secs(dashboard.ms)} | ${String(results(dashboard.agent)[0]?.text)}`)
assert.ok(dashboard.ms >= ROLLOUT_MS - 50)
assert.equal(results(dashboard.agent)[0]?.text, 'error rate 0.1%')

log('\n== 3. 超时后原样重试 ==')
platform.requests.length = 0
const retry = await turn('发布 payment-api 2.7', ...[1, 2, 3].map(() => call('deploy_release', release('2.7'))))
for (const [index, result] of results(retry.agent).entries()) log(`  第 ${String(index + 1)} 次部署 | ${result.text}`)
// 只打印提醒的第一句。
for (const { request, text: note } of reminders(retry.requests)) log(`  第 ${String(request)} 次模型请求里出现提醒 | ${note.split('. ')[0]}.`)
log(`  平台收到的部署请求 ${JSON.stringify(platform.requests)}`)
assert.deepEqual(reminders(retry.requests).map(r => r.request), [4])
assert.deepEqual(platform.requests, ['2.7', '2.7', '2.7'])
await sleep(ROLLOUT_MS)

log('\n== 4. 同样的参数查 9 次状态：提醒不拦调用 ==')
// 键的顺序故意打乱，重复判断看的是规范化后的参数。
const polls = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => call('check_status', n % 2 === 0 ? { version: '2.7', service: 'payment-api' } : release('2.7')))
statusCalls = 0
const poll = await turn('盯着 2.7 的发布状态', ...polls)
const pollNotes = reminders(poll.requests)
for (const { request, text: note } of pollNotes) log(`  第 ${String(request)} 次请求 | ${note.includes('\n') ? note.split('\n').slice(2, 4).join(' ⏎ ') : `${note.split('. ')[0]}.`}`)
log(`  check_status 实际执行 ${String(statusCalls)} 次`)
assert.deepEqual(pollNotes.map(r => r.request), [4, 6, 9])
assert.equal(statusCalls, 9)
assert.match(pollNotes[0]?.text ?? '', /^You are repeating the exact same tool call/)
assert.match(pollNotes[1]?.text ?? '', /consecutive_calls: 5\n/)
assert.match(pollNotes[2]?.text ?? '', /consecutive_calls: 8\n- arguments: \{"service":"payment-api","version":"2\.7"\}/)

log('\n== 5. 不算重复的几种循环 ==')
statusCalls = 0
const alternating = await turn('交替查 2.7 和 2.8', ...[1, 2, 3, 4, 5, 6].map(n => n % 2 === 0 ? call('check_status', release('2.8')) : call('check_status', release('2.7'))))
log(`  2.7 与 2.8 交替查 6 次         → 提醒 ${String(reminders(alternating.requests).length)} 条`)
const counting = await turn('带上次数', ...[1, 2, 3, 4, 5, 6].map(n => call('check_status', { ...release('2.7'), attempt: n })))
log(`  参数里多一个递增的 attempt，6 次 → 提醒 ${String(reminders(counting.requests).length)} 条`)
const interrupted = await turn('查两次', call('check_status', release('2.7')), call('check_status', release('2.7')))
const resumed = await more(interrupted.agent, '继续查', call('check_status', release('2.7')), call('check_status', release('2.7')))
log(`  查 2 次、人插一句、再查 2 次    → 提醒 ${String(reminders([...interrupted.requests, ...resumed.requests]).length)} 条`)
assert.equal(statusCalls, 6 + 6 + 4)
assert.equal(reminders(alternating.requests).length, 0)
assert.equal(reminders(counting.requests).length, 0)
assert.equal(reminders([...interrupted.requests, ...resumed.requests]).length, 0)

log('\n== 6. 随附工具声明的 timeoutMs ==')
// 只看工具定义：底层的 fs/shell/web 服务用空对象占位，工具不会被调用。
const bundled = new Context()
await bundled.plugin(SystemPrompt)
await bundled.plugin(ToolRuntime)
for (const service of ['fs', 'shell', 'shellEnv', 'web']) (bundled as unknown as { provide: (name: string, value: object) => void }).provide(service, {})
await bundled.plugin(toolFs)
await bundled.plugin(toolBash)
// 与基础组合里 tool-web 的配置相同。
await bundled.plugin(toolWeb, { fetch: true, searchTimeoutMs: 60000 })
const declared = ['bash', 'read', 'write', 'edit', 'web_fetch', 'web_search'].map(name => `${name}=${String(bundled.tools.get(name)?.timeoutMs)}`)
log(`  ${declared.join('  ')}`)
assert.deepEqual(declared, ['bash=undefined', 'read=undefined', 'write=undefined', 'edit=undefined', 'web_fetch=30000', 'web_search=60000'])
await bundled.fiber.dispose()

log('\n== 7. 用户中断和超时，谁先到算谁 ==')
for (const cancelAt of [500, 1500]) {
  const { agent } = await ctx.agents.create({ sessionId: SessionId(`duty-${String(++sessions)}`), agentOptions })
  model.calls.push(call('deploy_release_legacy', release(`3.${String(cancelAt)}`)))
  const t0 = at()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '用旧流水线发布' }], source: { kind: 'user' } }))
  await sleep(cancelAt)
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()
  const [result] = results(agent)
  log(`  ${String(cancelAt)}ms 时用户中断 deploy_release_legacy | 用时 ${secs(at() - t0)} | ${String(result?.text)} | 原始结果 ${String(inner.at(-1))}`)
  assert.equal(result?.text, cancelAt < TIMEOUT_MS ? 'Error: tool call aborted' : 'Error: tool call timed out after 1000ms')
  assert.equal(inner.at(-1), 'Error: tool call aborted')
}
await sleep(ROLLOUT_MS)

log('\n== 8. 被拒的调用、plugin 通知、长参数、同一步并发 ==')
const denied = await turn('回滚到 2.6', ...[1, 2, 3].map(() => call('rollback_release', release('2.6'))))
log(`  rollback_release 被 pre-execute 拒绝 3 次 | ${String(results(denied.agent)[0]?.text)} | 提醒在第 ${reminders(denied.requests).map(r => r.request).join('、')} 次请求 | 工具体执行 ${String(rollbackBodies)} 次`)
assert.deepEqual(reminders(denied.requests).map(r => r.request), [4])
assert.equal(rollbackBodies, 0)
assert.ok(results(denied.agent).every(r => r.text.startsWith('Error: ')))
const jobs = await turn('盯着冒烟任务', ...[1, 2, 3].map(() => call('check_job', { job: 'smoke-2.7' })))
const notice = jobs.requests.findIndex(r => r.messages.some(m => (m.source as { plugin?: string }).plugin === 'jobs'))
log(`  check_job 连调 3 次，第 ${String(notice + 1)} 次请求里夹着后台任务的 plugin 通知 → 提醒在第 ${reminders(jobs.requests).map(r => r.request).join('、')} 次请求`)
assert.equal(notice + 1, 3)
assert.deepEqual(reminders(jobs.requests).map(r => r.request), [4])
const longArgs = { ...release('2.7'), note: '灰度'.repeat(300) }
const longPoll = await turn('带备注查状态', ...[1, 2, 3, 4, 5].map(() => call('check_status', longArgs)))
const longNote = reminders(longPoll.requests).at(-1)?.text ?? ''
const quoted = longNote.split('\n').find(line => line.startsWith('- arguments: ')) ?? ''
log(`  参数 ${String(JSON.stringify(longArgs).length)} 字，第 5 次后的提醒里 | ${quoted.slice(0, 40)}……${quoted.slice(quoted.indexOf('…'))}`)
assert.match(quoted, /… \(\+\d+ more chars\)$/)
assert.equal(quoted.indexOf('…') - '- arguments: '.length, 500)
const parallel = await turn('并发查三次', [1, 2, 3].map(() => call('check_status', release('2.7'))))
log(`  同一步并发 3 个相同的 check_status → 提醒在第 ${reminders(parallel.requests).map(r => r.request).join('、')} 次请求`)
assert.deepEqual(reminders(parallel.requests).map(r => r.request), [2])

log('\n== 9. include / exclude ==')
async function host(config: object): Promise<Context> {
  const h = new Context()
  await h.plugin(LlmRuntime)
  await h.plugin(SessionStore)
  await h.plugin(SessionProjectionRegistry)
  await h.plugin(SystemPrompt)
  await h.plugin(ToolRuntime)
  await h.plugin(AgentRegistry)
  await h.plugin(AgentLoop, { agents: [] })
  await h.plugin(RepeatReminder, { thresholds: [3, 5, 8], argumentsPreviewChars: 500, ...config })
  for (const tool of [status, noteTool]) h.tools.register(tool)
  h.llm.registerAdapter(['scripted'], model)
  return h
}
const interleaved = [1, 2, 3, 4, 5].map(n => n % 2 === 0 ? call('note_progress', { text: '仍在灰度' }) : call('check_status', release('2.7')))
const noteOnly = [1, 2, 3].map(() => call('note_progress', { text: '仍在灰度' }))
const cases: [string, object, (Call | Call[])[], number[]][] = [
  ['默认配置，查 / 记 交替 5 次', {}, interleaved, []],
  ["exclude: ['note_*']，同一序列", { exclude: ['note_*'] }, interleaved, [6]],
  ["include: ['check_*']，记 3 次", { include: ['check_*'] }, noteOnly, []],
]
for (const [label, config, calls, expected] of cases) {
  const h = await host(config)
  const { agent } = await h.agents.create({ sessionId: SessionId('probe'), agentOptions })
  const before = model.requests.length
  model.calls.push(...calls)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: label }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const found = reminders(model.requests.slice(before)).map(r => r.request)
  log(`  ${label} → ${found.length === 0 ? '提醒 0 条' : `提醒在第 ${found.join('、')} 次请求`}`)
  assert.deepEqual(found, expected)
  await h.fiber.dispose()
}

await ctx.fiber.dispose()
