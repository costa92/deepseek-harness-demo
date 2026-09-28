/** Put the post-deploy smoke check into a dsh background job and a later re-check into a session reminder, then restart the host. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as Schedule from '@deepseek-ai/dsh-schedule'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { smoke: 'smoke' }
}

const log = (msg: string) => { console.log(msg) }
const root = mkdtempSync(join(tmpdir(), 'dsh-jobs-schedule-'))
process.on('exit', () => { rmSync(root, { recursive: true, force: true }) })

// ── 脚本化模型：按剧本调工具，剧本用完就回一句话 ─────────────────────────────────
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

// ── 合成发布平台和冒烟检查：检查在后台跑 smoke_ms 毫秒，版本 2.3 检查失败 ─────────────
interface Platform { deploys: string[]; cancels: string[] }
function deployTool(ctx: Context, platform: Platform) {
  return defineTool({
    name: 'deploy_release',
    description: 'Deploy one version, then start a background smoke check.',
    parameters: {
      service: { type: 'string', required: true },
      version: { type: 'string', required: true },
      smoke_ms: { type: 'number', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      platform.deploys.push(args.version)
      const label = `${args.service} ${args.version}`
      try {
        const id = ctx.jobs.start({
          kind: 'smoke',
          label,
          ...exec.agent === undefined ? {} : { owner: exec.agent },
          run() {
            const done = Promise.withResolvers<{ status: 'completed' | 'killed' | 'failed'; output: string; detail?: string }>()
            const timer = setTimeout(() => {
              done.resolve(args.version === '2.3'
                ? { status: 'failed', detail: 'error rate 7.2%', output: 'GET /health 200, POST /pay 500 x9' }
                : { status: 'completed', output: 'GET /health 200, POST /pay 200' })
            }, args.smoke_ms)
            return {
              cancel(reason) {
                clearTimeout(timer)
                platform.cancels.push(`${label}: ${reason ?? '-'}`)
                done.resolve({ status: 'killed', output: '' })
              },
              done: done.promise,
            }
          },
        })
        return Promise.resolve(`${args.service} ${args.version} deployed; smoke check ${id} started`)
      } catch (error: unknown) {
        return Promise.resolve(`${args.service} ${args.version} deployed; smoke check not started: ${(error as Error).message}`)
      }
    },
  })
}

// 查一次监控看板，要 150 毫秒。
const dashboard = defineTool({
  name: 'read_dashboard',
  description: 'Read the service dashboard.',
  parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute() {
    await sleep(150)
    return 'error rate 0.1%'
  },
})

// ── 宿主：会话落盘到 root；“重启”是销毁 Context 再用同一个 root 新建 ─────────────────
interface HostOptions { toolJobs?: boolean; schedule?: boolean }
interface Host { ctx: Context; model: ScriptedModel; agent: Agent; platform: Platform }
const agentOptions = { provider: 'scripted', model: 'mock' }
async function boot(options: HostOptions, session: { create?: string; resume?: string }): Promise<Host> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalJobRegistry)
  if (options.toolJobs !== false) await ctx.plugin(ToolJobs)
  if (options.schedule === true) await ctx.plugin(Schedule)
  const platform: Platform = { deploys: [], cancels: [] }
  ctx.tools.register(deployTool(ctx, platform))
  ctx.tools.register(dashboard)
  const model = new ScriptedModel()
  ctx.llm.registerAdapter(['scripted'], model)
  const { agent } = session.resume === undefined
    ? await ctx.agents.create({ sessionId: SessionId(session.create ?? 'host'), agentOptions })
    : await ctx.agents.resume({ resumeSessionId: SessionId(session.resume), agentOptions })
  return { ctx, model, agent, platform }
}
function say(host: Host, text: string, ...calls: Call[]): void {
  host.model.calls.push(...calls)
  host.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}
const deploy = (version: string, smokeMs: number): Call => ({ name: 'deploy_release', args: { service: 'payment-api', version, smoke_ms: smokeMs } })
async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 10) {
    if (check()) return
    await sleep(10)
  }
  assert.fail(`timed out waiting for ${what}`)
}
// oxlint-disable-next-line typescript/no-deprecated -- the demo reads the whole log on purpose
const events = (host: Host): readonly SessionEvent[] => host.agent.session.snapshotEvents()
const turns = (host: Host) => events(host).filter(e => e.type === 'turn/start').length
const text = (message: Message) => message.content.map(b => b.type === 'text' ? b.text : '').join('')
/** Plugin-sourced messages (job notices, reminders) in one model request, oldest first. */
const pluginText = (request: GenerateOptions | undefined, plugin: string) => (request?.messages ?? [])
  .filter(m => m.source.kind === 'plugin' && m.source.plugin === plugin).map(text)
function toolResults(host: Host): string[] {
  return events(host).flatMap((e) => {
    if (e.type !== 'tool/result') return []
    const [block] = e.data.message.content
    return [block.content.map(c => c.type === 'text' ? c.text : '').join('')]
  })
}

log('== 1. 冒烟检查放到后台，完成通知怎么回到会话 ==')
const busy = await boot({}, { create: 'busy' })
// 轮次还在进行：部署后模型去查看板，检查在这期间完成。
say(busy, '发布 payment-api 2.4', deploy('2.4', 50), { name: 'read_dashboard', args: {} })
await busy.agent.whenIdle()
log(`轮次进行中完成：部署结果「${toolResults(busy)[0]}」`)
const busyNotice = busy.model.requests.findIndex(r => pluginText(r, 'tool-jobs').length > 0)
log(`  通知在第 ${busyNotice + 1} 次模型请求里出现，同一轮内，轮次共 ${turns(busy)} 个`)
log(`  通知原文：${pluginText(busy.model.requests[busyNotice], 'tool-jobs')[0]}`)
assert.equal(toolResults(busy)[0], 'payment-api 2.4 deployed; smoke check smoke-1 started')
assert.equal(busyNotice, 2)
assert.equal(turns(busy), 1)
assert.equal(pluginText(busy.model.requests[busyNotice], 'tool-jobs')[0], 'background job smoke-1 (smoke: payment-api 2.4) finished [status: completed]. Read its output with job_output.')

const idle = await boot({}, { create: 'idle' })
say(idle, '发布 payment-api 2.3', deploy('2.3', 200))
await idle.agent.whenIdle()
const idleBefore = idle.model.requests.length
await until(() => turns(idle) === 2 && idle.agent.status === 'idle', 'the wake-up turn')
log(`轮次结束后才完成：第一轮 ${idleBefore} 次请求后空闲，检查完成时自动开了第 ${turns(idle)} 轮`)
log(`  这一轮的新消息来源 ${JSON.stringify(idle.model.requests[idleBefore]?.messages.at(-1)?.source)}`)
log(`  通知原文：${pluginText(idle.model.requests[idleBefore], 'tool-jobs')[0]}`)
assert.equal(idleBefore, 2)
assert.deepEqual(idle.model.requests[idleBefore]?.messages.at(-1)?.source, { kind: 'plugin', plugin: 'tool-jobs', form: 'notice', summary: 'smoke payment-api 2.3 [status: failed, error rate 7.2%]' })

const waited = await boot({}, { create: 'waited' })
say(waited, '发布 payment-api 2.4', deploy('2.4', 50), { name: 'job_output', args: { job_id: 'smoke-1', wait: true } })
await waited.agent.whenIdle()
await sleep(300)
log(`模型主动 job_output 等结果：${JSON.stringify(toolResults(waited)[1])}；之后的通知 ${waited.model.requests.flatMap(r => pluginText(r, 'tool-jobs')).length} 条，轮次 ${turns(waited)} 个`)
assert.equal(toolResults(waited)[1], 'GET /health 200, POST /pay 200\n[status: completed]')
assert.equal(waited.model.requests.flatMap(r => pluginText(r, 'tool-jobs')).length, 0)
assert.equal(turns(waited), 1)

const noJobs = await boot({ toolJobs: false }, { create: 'no-tool-jobs' })
say(noJobs, '发布 payment-api 2.4', deploy('2.4', 50))
await noJobs.agent.whenIdle()
log(`没挂 tool-jobs：${toolResults(noJobs)[0]}`)
assert.match(toolResults(noJobs)[0] ?? '', /^payment-api 2\.4 deployed; smoke check not started: /)
assert.deepEqual(noJobs.platform.deploys, ['2.4'])

log('\n== 2. 空闲时连续完成 4 个检查：唤醒预算 ==')
const chain = await boot({}, { create: 'chain' })
say(chain, '连发 4 个版本', deploy('2.4', 100), deploy('2.5', 400), deploy('2.6', 700), deploy('2.7', 1000))
await chain.agent.whenIdle()
await until(() => chain.ctx.jobs.list(chain.agent).every(j => j.status !== 'running') && chain.agent.status === 'idle', 'all four checks', 5000)
await sleep(200)
const woken = turns(chain) - 1
const seenBefore = chain.model.requests.flatMap(r => pluginText(r, 'tool-jobs')).length
log(`4 个检查都完成后：唤醒开了 ${woken} 轮，模型见过 ${new Set(chain.model.requests.flatMap(r => pluginText(r, 'tool-jobs'))).size} 条通知`)
say(chain, '现在状态如何？')
await chain.agent.whenIdle()
const late = pluginText(chain.model.requests.at(-1), 'tool-jobs').at(-1)
log(`用户再发一条消息，第 4 条通知才跟着进请求：${late}`)
assert.equal(woken, 3)
assert.equal(new Set(chain.model.requests.slice(0, -1).flatMap(r => pluginText(r, 'tool-jobs'))).size, 3)
assert.ok(seenBefore >= 3)
assert.equal(late, 'background job smoke-4 (smoke: payment-api 2.7) finished [status: completed]. Read its output with job_output.')

log('\n== 3. 检查还没跑完，宿主重启 ==')
const before = await boot({}, { create: 'restart-job' })
say(before, '发布 payment-api 2.4', deploy('2.4', 60_000))
await before.agent.whenIdle()
const running = before.ctx.jobs.list(before.agent).map(j => `${j.id} ${j.status}`)
await before.ctx.fiber.dispose()
log(`重启前：${running.join(', ')}；销毁宿主时检查被取消：${before.platform.cancels.join(', ')}`)
const after = await boot({}, { resume: 'restart-job' })
say(after, '冒烟检查结果呢？再发 2.5', { name: 'job_list', args: {} }, { name: 'job_output', args: { job_id: 'smoke-1' } }, deploy('2.5', 50))
await after.agent.whenIdle()
const [listed, output, redeploy] = toolResults(after).slice(-3)
log(`恢复会话后 job_list：${listed}`)
log(`job_output smoke-1：${output}`)
const oldNotices = [...before.model.requests, ...after.model.requests].flatMap(r => pluginText(r, 'tool-jobs')).filter(s => s.includes('(smoke: payment-api 2.4)'))
log(`重启前后模型收到的 2.4 检查通知：${oldNotices.length} 条`)
log(`重启后再部署 2.5：${redeploy}`)
log(`  会话历史里 smoke-1 出现在：${toolResults(after).filter(r => r.includes('smoke-1')).length} 条工具结果里，前两条指重启前那次检查，最后一条是新的检查`)
assert.deepEqual(running, ['smoke-1 running'])
assert.deepEqual(before.platform.cancels, ['payment-api 2.4: jobs service disposed'])
assert.equal(listed, '(no background jobs)')
assert.equal(output, 'Error: unknown job smoke-1')
assert.equal(oldNotices.length, 0)
assert.equal(redeploy, 'payment-api 2.5 deployed; smoke check smoke-1 started')
assert.equal(toolResults(after).filter(r => r.includes('smoke-1')).length, 3)

log('\n== 4. schedule：稍后回查的提醒 ==')
// 提醒用真实时钟，时间戳每次不同，输出里替换成占位。
const redact = (s: string) => s.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<UTC>')
const remind = await boot({ schedule: true }, { create: 'remind' })
say(remind, '1 秒后提醒我看 2.4 的错误率', { name: 'schedule_create', args: { prompt: '回查 payment-api 2.4 的错误率', after_seconds: 1 } })
await remind.agent.whenIdle()
const created = JSON.parse(toolResults(remind)[0] ?? '{}') as { scheduledAt?: string }
log(`schedule_create：${redact(toolResults(remind)[0] ?? '')}`)
const createdAt = Date.now()
await until(() => turns(remind) === 2 && remind.agent.status === 'idle', 'the reminder turn')
const delay = Date.now() - createdAt
const reminder = remind.model.requests.at(-1)?.messages.at(-1)
const reminderText = reminder === undefined ? '' : text(reminder)
log(`到期后自动开了第 2 轮，新消息来源 ${JSON.stringify(reminder?.source)}：`)
for (const line of redact(reminderText).split('\n')) log(`  ${line}`)
say(remind, '每分钟提醒一次', { name: 'schedule_create', args: { prompt: '看错误率', every_seconds: 60 } })
await remind.agent.whenIdle()
log(`every_seconds: 60 → ${toolResults(remind).at(-1)}`)
assert.ok(remind.model.requests[0]?.tools?.some(t => t.name === 'schedule_create'))
assert.ok(delay > 500 && delay < 2500, `reminder delay ${delay}ms`)
assert.deepEqual(reminder?.source, { kind: 'plugin', plugin: 'schedule' })
assert.equal(reminderText.split('\n')[3], `occurrence_at: ${created.scheduledAt}`)
assert.match(reminderText, /^\[SCHEDULE REMINDER\]\n/)
assert.equal(toolResults(remind).at(-1), '{"code":"frequency_too_high","message":"every_seconds must be at least 300."}')

log('\n== 5. 提醒到期时宿主不在 ==')
const gone = await boot({ schedule: true }, { create: 'restart-remind' })
say(gone, '2 秒后提醒我回查', { name: 'schedule_create', args: { prompt: '回查 payment-api 2.4', after_seconds: 2 } })
await gone.agent.whenIdle()
const goneAt = (JSON.parse(toolResults(gone)[0] ?? '{}') as { scheduledAt?: string }).scheduledAt
await gone.ctx.fiber.dispose()
await sleep(2500)
const plainHost = await boot({}, { resume: 'restart-remind' })
await sleep(1500)
log(`到期后用不挂 schedule 的宿主恢复会话，等 1.5 秒：模型请求 ${plainHost.model.requests.length} 次`)
await plainHost.ctx.fiber.dispose()
const back = await boot({ schedule: true }, { resume: 'restart-remind' })
const resumedAt = Date.now()
await until(() => back.model.requests.length > 0 && back.agent.status === 'idle', 'the overdue reminder')
const lateDelay = Date.now() - resumedAt
const late2 = back.model.requests[0]?.messages.at(-1)
const late2Text = late2 === undefined ? '' : text(late2)
log('再用挂了 schedule 的宿主恢复：恢复后 1 秒内收到提醒')
log(`  occurrence_at 仍是原定时间：${String(late2Text.includes(`occurrence_at: ${goneAt}`))}`)
const changes = events(back).filter(e => e.type === 'schedule/change').map(e => e.type === 'schedule/change' ? e.data.operation : '')
log(`  会话日志里的 schedule/change：${changes.join(' → ')}`)
assert.equal(plainHost.model.requests.length, 0)
assert.ok(lateDelay < 1000, `overdue delivery took ${lateDelay}ms`)
assert.deepEqual(late2?.source, { kind: 'plugin', plugin: 'schedule' })
assert.ok(late2Text.includes(`occurrence_at: ${goneAt}`))
assert.deepEqual(changes, ['create', 'dispatch'])

await Promise.all([busy, idle, waited, noJobs, chain, after, remind, back].map(host => host.ctx.fiber.dispose()))
