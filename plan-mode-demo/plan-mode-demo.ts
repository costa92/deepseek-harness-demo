/** Put the on-call agent into dsh plan mode: what a deploy call does there, how a plan is reviewed, how guards and approval stack on top, and what survives a restart. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as checkpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import UserQuestionService, { UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'

const log = (msg: string) => { console.log(msg) }
const base = mkdtempSync(join(tmpdir(), 'dsh-plan-mode-'))
process.on('exit', () => { rmSync(base, { recursive: true, force: true }) })

// 计划引导原样取自基础组合（packages/bundle/base/cordis.patch.yml 里 plan-mode 的 section）。
const bundle = readFileSync(new URL('../../packages/bundle/base/cordis.patch.yml', import.meta.url), 'utf8')
const block = /id: plan-mode\n[^\n]*\n\s+config:\n\s+section: \|\n([\s\S]*?)\n\n\s+- id:/.exec(bundle)?.[1]
assert.ok(block, 'plan-mode section not found in the base bundle')
const SECTION = block.split('\n').map(line => line.trim()).join('\n')
assert.match(SECTION, /^You are in plan mode\./)

// ── 脚本化模型：每次请求取一步；一步可以带多个工具调用，也可以在回复期间做点事 ─────────
interface Call { name: string; args: object }
interface Step { calls?: Call[]; text?: string; during?: () => Promise<unknown> }
class ScriptedModel extends LlmAdapter {
  readonly steps: Step[] = []
  readonly requests: GenerateOptions[] = []
  private seq = 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const step = this.steps.shift()
    assert.ok(step, 'the scripted model ran out of steps')
    await step.during?.()
    const chunks: StreamChunk[] = []
    const calls = step.calls ?? []
    calls.forEach((call, index) => {
      const id = ToolCallId(`call-${++this.seq}`)
      const json = JSON.stringify(call.args)
      chunks.push(
        { type: 'block-start', index, blockType: 'tool-call' },
        { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: json },
        { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: json } },
      )
    })
    if (step.text !== undefined) {
      const index = calls.length
      chunks.push(
        { type: 'block-start', index, blockType: 'text' },
        { type: 'block-end', index, block: { type: 'text', text: step.text } },
      )
    }
    chunks.push(
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: calls.length > 0 ? 'tool-calls' : 'stop' } },
    )
    for (const chunk of chunks) yield chunk
  }
}

// ── 合成发布平台：收到部署请求就记下来并上线 ──────────────────────────────────
const platform: string[] = []
const deployRelease = defineTool({
  name: 'deploy_release',
  description: 'Deploy one version of a service to the synthetic release platform.',
  parameters: { service: { type: 'string', required: true }, version: { type: 'string', required: true } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute(args) {
    platform.push(args.version)
    return Promise.resolve(`${args.service} ${args.version} 已上线`)
  },
})

// ── 宿主：agent 循环 + 命令 + 用户提问 + plan-mode，会话落盘到 JSONL ─────────────
const sessionsDir = join(base, 'sessions')
const agentOptions = { provider: 'scripted', model: 'mock' }
let planFiber: { dispose: () => Promise<unknown> } | undefined
async function boot(): Promise<{ ctx: Context; model: ScriptedModel }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsDir, compression: 'none' })
  await ctx.plugin(checkpointPolicy)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(UserQuestionService)
  const fiber = ctx.plugin(PlanModeController, { section: SECTION })
  await fiber
  planFiber = fiber as unknown as { dispose: () => Promise<unknown> }
  // plan-mode 的 /plan 命令挂在 commands 服务就绪之后。
  await new Promise(resolve => setImmediate(resolve))
  const model = new ScriptedModel()
  ctx.llm.registerAdapter(['scripted'], model)
  ctx.tools.register(deployRelease)
  return { ctx, model }
}
let { ctx, model } = await boot()

// ── 工具函数 ────────────────────────────────────────────────────────────────
const open = async (id: string) => (await ctx.agents.create({ sessionId: SessionId(id), agentOptions })).agent
const idle = (agent: Agent) => new Promise<void>((resolve) => {
  const off = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent && status === 'idle') { off(); resolve() }
  })
})
/** 人发一句话，模型按 steps 走完一轮；返回这一轮的模型请求。 */
async function say(agent: Agent, text: string, ...steps: Step[]): Promise<GenerateOptions[]> {
  const before = model.requests.length
  model.steps.push(...steps)
  const done = idle(agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await done
  assert.equal(model.steps.length, 0, 'the turn ended before the script did')
  return model.requests.slice(before)
}
const signal = new AbortController().signal
const slash = async (agent: Agent, line: string) => (await ctx.commands.execute(agent, line, [], signal))?.result.text
/** 带消息的 /plan：命令把消息 steer 进去，开出一轮。 */
async function slashTurn(agent: Agent, line: string, ...steps: Step[]): Promise<{ text?: string; requests: GenerateOptions[] }> {
  const before = model.requests.length
  model.steps.push(...steps)
  const done = idle(agent)
  const text = await slash(agent, line)
  await done
  assert.equal(model.steps.length, 0)
  return { text, requests: model.requests.slice(before) }
}
const events = (agent: Agent): readonly SessionEvent[] => agent.session.snapshotEvents()
const textOf = (message: Message) => message.content.map(b => b.type === 'text' ? b.text : '').join('')
const guided = (request: GenerateOptions | undefined) => {
  const head = request?.messages[0]
  return head?.role === 'system' && textOf(head).includes(SECTION)
}
const toolNames = (request: GenerateOptions | undefined) => (request?.tools ?? []).map(t => t.name)
const planNotices = (requests: GenerateOptions[]) => [...new Set(requests.flatMap(r => r.messages
  .filter(m => m.source.kind === 'plugin' && (m.source as { plugin?: string }).plugin === 'plan-mode')
  .map(textOf)))]
function results(agent: Agent): { name: string; text: string }[] {
  const names = new Map<string, string>()
  return events(agent).flatMap((e) => {
    if (e.type === 'tool/call') names.set(e.data.callId, e.data.name)
    if (e.type !== 'tool/result') return []
    const [block] = e.data.message.content
    return [{ name: names.get(block.toolCallId) ?? '?', text: block.content.map(c => c.type === 'text' ? c.text : '').join('') }]
  })
}
const planView = (agent: Agent) => ctx.sessionProjections.snapshot(agent.session, ['plan']).values.plan
const json = (value: unknown) => JSON.stringify(value)
const deploy = (version: string): Call => ({ name: 'deploy_release', args: { service: 'payment-api', version } })
const exitPlan = (plan: string): Call => ({ name: 'exit_plan_mode', args: { plan } })
const PLAN = '# payment-api 2.8 发布计划\n1. 查 2.7 的失败记录\n2. 先发 10% 流量\n3. 观察 15 分钟错误率，再全量'

log('== 1. 计划模式下，模型直接调部署工具 ==')
const first = await open('oncall-1')
const entered = await slashTurn(first, '/plan 先出 payment-api 2.7 的发布计划', { calls: [deploy('2.7')] }, { text: '2.7 已经发出去了。' })
log(`  /plan 的回执 | ${String(entered.text)}`)
log(`  第 1 次请求 | 系统提示含计划引导：${String(guided(entered.requests[0]))}，工具目录 ${json(toolNames(entered.requests[0]))}`)
log(`  deploy_release 的结果 | ${String(results(first)[0]?.text)}`)
log(`  平台收到的部署 ${json(platform)}，这一轮 plan-mode 发出的提醒 ${String(planNotices(entered.requests).length)} 条`)
assert.equal(entered.text, 'Plan mode on. Use /plan off to leave.')
assert.ok(guided(entered.requests[0]) && guided(entered.requests[1]))
assert.deepEqual(toolNames(entered.requests[0]).sort(), ['deploy_release', 'exit_plan_mode'])
assert.equal(results(first)[0]?.text, 'payment-api 2.7 已上线')
assert.deepEqual(platform, ['2.7'])
assert.deepEqual(planNotices(entered.requests), [])

log('\n== 2. 不提交计划就结束一轮 ==')
const prose = await say(first, '继续', { text: '计划：1. 查 2.7 的失败记录 2. 灰度 10% 3. 全量。可以执行吗？' })
log(`  模型用文字回了一份计划 | 这一轮请求 ${String(prose.length)} 次，结束后计划状态 ${json(ctx.planMode.get(first))}`)
const agreed = await say(first, '可以，照这个做', { calls: [deploy('2.8')] }, { text: '2.8 已上线。' })
log(`  人回“可以，照这个做” | 请求仍含计划引导：${String(agreed.every(guided))}，部署结果 ${String(results(first)[1]?.text)}`)
log(`  两轮下来：plan-mode 提醒 ${String(planNotices([...prose, ...agreed]).length)} 条，计划状态 ${json(ctx.planMode.get(first))}`)
assert.equal(prose.length, 1)
assert.ok(prose.every(guided) && agreed.every(guided))
assert.deepEqual(ctx.planMode.get(first), { active: true })
assert.equal(results(first)[1]?.text, 'payment-api 2.8 已上线')
assert.deepEqual(planNotices([...prose, ...agreed]), [])
assert.equal(events(first).filter(e => e.type === 'plan/mode').length, 1)

log('\n== 3. 用 exit_plan_mode 提交计划：没人应答、标题不对、打回、批准 ==')
platform.length = 0
const second = await open('oncall-2')
log(`  /plan（空闲时）| ${String(await slash(second, '/plan'))}`)
const asked: AskUserQuestionItem[] = []
const answers: AskUserQuestionAnswer[] = [
  { answers: [{ id: 'plan-review', selected: [], custom: '先确认 2.7 的回滚方案' }] },
  { answers: [{ id: 'plan-review', selected: ['Approve'] }] },
]
const reviewed = await say(second, '准备发 payment-api 2.8',
  { calls: [exitPlan(PLAN)] },
  { calls: [exitPlan(PLAN.replace(/^# /, '## '))], during: () => {
    // 从这一步起才有人应答评审。
    ctx.on('user-questions/request', (request) => {
      asked.push(...request.questions)
      const answer = answers.shift()
      assert.ok(answer, 'unexpected plan review')
      return Promise.resolve(answer)
    })
    return Promise.resolve()
  } },
  { calls: [exitPlan(PLAN)] },
  { calls: [exitPlan(PLAN)] },
  { calls: [deploy('2.8')] },
  { text: '2.8 已按计划上线。' })
const r3 = results(second)
log(`  没人应答评审     | ${String(r3[0]?.text)}`)
log(`  计划用 ## 开头   | ${String(r3[1]?.text)}`)
const review = asked[0]
log(`  应答者收到       | header=${String(review?.header)}，选项 ${json(review?.options?.map(o => o.label))}，intent=${String(review?.intent?.kind)}，detail 首行 ${String(review?.detail?.split('\n')[0])}`)
log(`  打回并附意见     | ${String(r3[2]?.text)}`)
log(`  批准             | ${String(r3[3]?.text)}`)
const log2 = events(second)
const approvedAt = log2.findIndex(e => e.type === 'tool/result' && e.data.message.content[0].toolCallId === log2.filter(x => x.type === 'tool/call' && x.data.name === 'exit_plan_mode').at(-1)?.data.callId)
const tail = log2.slice(approvedAt, approvedAt + 4).map(e => e.type === 'plan/mode' ? `plan/mode ${json(e.data)}` : e.type)
log(`  批准后的日志     | ${tail.join(' → ')}`)
log(`  批准后的下一次请求 | 含计划引导：${String(guided(reviewed[4]))}，工具目录不变：${String(json(toolNames(reviewed[4])) === json(toolNames(reviewed[0])))}，plan-mode 提醒 ${String(planNotices(reviewed).length)} 条`)
log(`  部署 2.8         | ${String(r3[4]?.text)}；计划状态 ${json(ctx.planMode.get(second))}`)
assert.equal(r3[0]?.text, 'Error: no user-questions answerer accepted the request')
assert.equal(r3[1]?.text, 'Error: exit_plan_mode requires a non-empty markdown plan starting with a # heading')
assert.equal(asked.length, 2)
assert.equal(review?.header, 'Plan review')
assert.deepEqual(review?.options?.map(o => o.label), ['Approve', 'Keep planning'])
assert.equal(review?.intent?.kind, 'plan-review')
assert.equal(review?.detail, PLAN)
assert.equal(r3[2]?.text, 'Error: The user chose to keep planning; their feedback: 先确认 2.7 的回滚方案')
assert.equal(r3[3]?.text, 'Plan approved — plan mode exited; carry out the plan starting with your next step.')
assert.deepEqual(tail, ['tool/result', 'step/end', 'plan/mode {"active":false}', 'step/start'])
assert.ok(reviewed.slice(0, 4).every(guided))
assert.equal(guided(reviewed[4]), false)
assert.deepEqual(toolNames(reviewed[4]), toolNames(reviewed[0]))
assert.deepEqual(planNotices(reviewed), [])
assert.equal(r3[4]?.text, 'payment-api 2.8 已上线')
assert.deepEqual(ctx.planMode.get(second), { active: false })

log('\n== 4. 自己加一道守卫：计划模式下不许部署 ==')
platform.length = 0
const seenByGuard: string[] = []
const noDeployInPlan = ctx.tools.guard((exec) => {
  if (exec.name !== 'deploy_release' || exec.agent === undefined) return undefined
  const state = ctx.planMode.get(exec.agent)
  seenByGuard.push(json(state))
  return state.active ? '计划模式下不部署，先用 exit_plan_mode 提交计划' : undefined
})
answers.push({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
const third = await open('oncall-3')
await slash(third, '/plan')
await say(third, '发布 payment-api 2.9',
  { calls: [deploy('2.9')] },
  { calls: [exitPlan(PLAN.replace('2.8', '2.9')), deploy('2.9')] },
  { calls: [deploy('2.9')] },
  { text: '2.9 已上线。' })
const r4 = results(third)
log(`  计划模式中直接部署          | ${String(r4[0]?.text)}`)
log(`  同一条回复里先提交再部署    | exit_plan_mode：${String(r4[1]?.text.split(' — ')[0])}；deploy_release：${String(r4[2]?.text)}`)
log(`    守卫此刻读到的计划状态 ${String(seenByGuard[1])}`)
log(`  下一步再部署                | ${String(r4[3]?.text)}（守卫读到 ${String(seenByGuard[2])}）`)
log(`  平台收到的部署 ${json(platform)}`)
assert.equal(r4[0]?.text, 'Error: 计划模式下不部署，先用 exit_plan_mode 提交计划')
assert.equal(r4[1]?.name, 'exit_plan_mode')
assert.match(r4[1]?.text ?? '', /^Plan approved/)
assert.equal(r4[2]?.text, 'Error: 计划模式下不部署，先用 exit_plan_mode 提交计划')
assert.deepEqual(seenByGuard, ['{"active":true}', '{"active":true,"pending":false}', '{"active":false}'])
assert.equal(r4[3]?.text, 'payment-api 2.9 已上线')
assert.deepEqual(platform, ['2.9'])

log('\n== 5. 叠加审批：部署要人批，再切到 danger-full-access 预设 ==')
platform.length = 0
await ctx.plugin(ApprovalService, { policy: 'ask' })
ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> =>
  exec.name === 'deploy_release' ? Promise.resolve({ kind: 'ask', reason: '部署生产要值班负责人批准' }) : next())
const approvals: string[] = []
ctx.on('approval/request', (req) => {
  approvals.push(`${req.toolName}：${String(req.reason)}`)
  return Promise.resolve('allowed-once' as const)
})
const fourth = await open('oncall-4')
await slash(fourth, '/plan')
await say(fourth, '发布 payment-api 3.0', { calls: [deploy('3.0')] }, { text: '被拦了。' })
log(`  计划模式中部署 | 审批人被问 ${String(approvals.length)} 次（${String(approvals[0])}），批准；结果 ${String(results(fourth)[0]?.text)}`)
assert.deepEqual(approvals, ['deploy_release：部署生产要值班负责人批准'])
assert.equal(results(fourth)[0]?.text, 'Error: 计划模式下不部署，先用 exit_plan_mode 提交计划')
// 权限预设服务按基础组合的预设表挂上；它要求 bash 执行器声明沙箱模式，这里用一个只带 sandboxMode 的占位。
;(ctx as unknown as { provide: (name: string, value: object) => void }).provide('shell', { sandboxMode: 'workspace-write' })
await ctx.plugin(PermissionPresetService, { presets: {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
} })
const knobsBefore = events(fourth).length
ctx.permissionPresets.set(fourth.session, 'danger-full-access')
const knobEvents = events(fourth).slice(knobsBefore).map(e => `${e.type} ${json(e.data)}`)
log(`  切到 danger-full-access 预设写入 | ${knobEvents.join('；')}`)
assert.deepEqual(knobEvents, ['permission/preset {"preset":"danger-full-access"}', 'sandbox/mode {"mode":"danger-full-access"}', 'approval/policy {"policy":"never"}'])
answers.push({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
const reviewsBefore = asked.length
await say(fourth, '提交计划', { calls: [exitPlan(PLAN.replace('2.8', '3.0'))] }, { calls: [deploy('3.0')] }, { text: '部署被拒。' })
const r5 = results(fourth)
log(`  审批策略 never | 计划评审照样问人 ${String(asked.length - reviewsBefore)} 次：${String(r5[1]?.text.split(' — ')[0])}`)
log(`                 | 退出计划后部署：审批人被问 ${String(approvals.length - 1)} 次，结果 ${String(r5[2]?.text)}`)
log(`  平台收到的部署 ${json(platform)}`)
assert.equal(asked.length - reviewsBefore, 1)
assert.match(r5[1]?.text ?? '', /^Plan approved/)
assert.equal(approvals.length, 1)
assert.equal(r5[2]?.text, 'Error: the user rejected tool "deploy_release"')
assert.deepEqual(platform, [])
noDeployInPlan()

log('\n== 6. 轮中选的 /plan off：同进程下一步生效，重启后丢失 ==')
const offMidTurn = (agent: Agent, out: string[]): Step => ({
  text: '先看一下 3.0 的情况。',
  during: async () => { out.push(String(await slash(agent, '/plan off'))) },
})
const sameProcess = await open('oncall-5')
await slash(sameProcess, '/plan')
const said5: string[] = []
await say(sameProcess, '准备 3.1 的发布计划', offMidTurn(sameProcess, said5))
log(`  模型回复期间人发 /plan off | ${String(said5[0])}`)
log(`    这一轮结束后 | 计划状态 ${json(ctx.planMode.get(sameProcess))}，界面投影 ${json(planView(sameProcess))}`)
const next5 = await say(sameProcess, '继续', { text: '好的。' })
log(`  同一进程，人发“继续” | 含计划引导：${String(guided(next5[0]))}，plan-mode 通知 ${json(planNotices(next5))}`)
assert.equal(said5[0], 'Leaving plan mode (applies from the next step).')
assert.equal(guided(next5[0]), false)
assert.deepEqual(planNotices(next5), ['The user switched this session back to the default mode.'])
assert.deepEqual(ctx.planMode.get(sameProcess), { active: false })

const restarted = await open('oncall-6')
await slash(restarted, '/plan')
const said6: string[] = []
await say(restarted, '准备 3.1 的发布计划', offMidTurn(restarted, said6))
log(`  另一个会话同样操作后重启宿主 | 重启前：计划状态 ${json(ctx.planMode.get(restarted))}，界面投影 ${json(planView(restarted))}`)
assert.deepEqual(ctx.planMode.get(restarted), { active: true, pending: false })
assert.deepEqual(planView(restarted), { active: true, pending: true })
await ctx.sessions.flush(restarted.session)
await ctx.fiber.dispose();
({ ctx, model } = await boot())
const resumed = (await ctx.agents.resume({ resumeSessionId: SessionId('oncall-6'), agentOptions })).agent
log(`    恢复会话后 | 计划状态 ${json(ctx.planMode.get(resumed))}，界面投影 ${json(planView(resumed))}`)
const after = await say(resumed, '继续', { text: '好的。' })
log(`    人发“继续” | 含计划引导：${String(guided(after[0]))}，这一轮后计划状态 ${json(ctx.planMode.get(resumed))}，界面投影 ${json(planView(resumed))}`)
assert.deepEqual(ctx.planMode.get(resumed), { active: true })
assert.equal(guided(after[0]), true)
assert.deepEqual(planView(resumed), { active: true, pending: true })

log('\n== 7. 评审没有得到回答：关掉评审改为发言、评审期间 plan-mode 重载 ==')
// 重启后的宿主重新挂一个评审人；每次评审按队列里的动作回应。
const reviewActions: (() => Promise<AskUserQuestionAnswer>)[] = []
ctx.on('user-questions/request', () => {
  const action = reviewActions.shift()
  assert.ok(action, 'unexpected plan review')
  return action()
})
const approve = () => Promise.resolve<AskUserQuestionAnswer>({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
reviewActions.push(
  // 界面上关掉评审、回到输入框。
  () => Promise.reject(new UserQuestionError('the user dismissed the question', 'ASK_CANCELLED')),
  // 评审还没回答时 plan-mode 被重载（例如改了配置），随后才点批准。
  async () => {
    await planFiber?.dispose()
    const fiber = ctx.plugin(PlanModeController, { section: SECTION })
    await fiber
    planFiber = fiber as unknown as { dispose: () => Promise<unknown> }
    return await approve()
  },
)
const seventh = await open('oncall-7')
await slash(seventh, '/plan')
const r7Requests = await say(seventh, '准备发 payment-api 3.2', { calls: [exitPlan(PLAN.replace('2.8', '3.2'))] }, { calls: [exitPlan(PLAN.replace('2.8', '3.2'))] }, { text: '重新提交前先等你的意见。' })
const r7 = results(seventh)
log(`  评审人关掉评审改为发言 | ${String(r7[0]?.text)}`)
log(`  评审期间 plan-mode 重载 | ${String(r7[1]?.text)}`)
log(`  这一轮后计划状态 ${json(ctx.planMode.get(seventh))}，最后一次请求含计划引导：${String(guided(r7Requests.at(-1)))}`)
assert.equal(r7[0]?.text, 'Error: The user dismissed the plan review to speak instead; stay in plan mode, stop here, and wait for their message.')
assert.equal(r7[1]?.text, 'Error: the plan-mode service was reloaded while the plan was under review; present the plan again')
assert.deepEqual(ctx.planMode.get(seventh), { active: true })
assert.equal(guided(r7Requests.at(-1)), true)
assert.equal(reviewActions.length, 0)

log('\n== 8. fork 继承已记录的计划状态 ==')
const parentEvents = events(seventh)
const cut = parentEvents.findLast(e => e.type === 'turn/end')
assert.ok(cut)
const seed = parentEvents.slice(0, cut.seq + 1)
const forked = (await ctx.agents.create({
  sessionId: SessionId('oncall-7-fork'),
  seed,
  inheritedEventCount: SessionLogOffset(seed.length),
  meta: { parentSession: seventh.session.header.id, isSeeded: true },
  agentOptions,
})).agent
const fresh = await open('oncall-8')
log(`  fork 出的会话 | 计划状态 ${json(ctx.planMode.get(forked))}；新开的会话 | 计划状态 ${json(ctx.planMode.get(fresh))}`)
const forkTurn = await say(forked, '在分支里继续规划', { text: '好的。' })
log(`  fork 出的会话第一次请求 | 含计划引导：${String(guided(forkTurn[0]))}`)
assert.deepEqual(ctx.planMode.get(forked), { active: true })
assert.deepEqual(ctx.planMode.get(fresh), { active: false })
assert.equal(guided(forkTurn[0]), true)

await ctx.fiber.dispose()
