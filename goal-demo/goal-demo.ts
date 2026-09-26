/** Drive a "patrol every service's latest release" goal through dsh-goal, dsh-tool-goal and the round driver. */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as CheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import GoalService from '@deepseek-ai/dsh-goal'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'

const log = (msg: string) => { console.log(msg) }

// ── 脚本化模型：每一轮（turn）一组动作，每次请求取下一个 ─────────────────────
type Action = (lastToolText: string) => StreamChunk[]
const textOf = (message: Message | undefined) => (message?.content ?? [])
  .map(b => b.type === 'text' ? b.text : b.type === 'tool-result' ? b.content.map(c => c.type === 'text' ? c.text : '').join('') : '')
  .join('')
/** A turn starts with a human message or a `<goal_round>` prompt; the wrap-up notice does not. */
const startsTurn = (message: Message | undefined) => message?.role === 'user'
  && message.content.every(b => b.type === 'text') && !textOf(message).startsWith('<goal_complete>')
  && !textOf(message).startsWith('<goal_blocked>')

class ScriptedModel extends LlmAdapter {
  readonly turns: Action[][] = []
  requests = 0
  private current: Action[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests++
    const last = options.messages.at(-1)
    if (startsTurn(last)) this.current = this.turns.shift() ?? []
    const action = this.current.shift()
    assert.ok(action, `the scripted model has no action for: ${textOf(last).slice(0, 60)}`)
    for (const chunk of action(textOf(last))) yield chunk
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
const call = (name: string, args: (lastToolText: string) => object): Action => (last) => {
  const id = ToolCallId(`call-${++callSeq}`)
  const json = JSON.stringify(args(last))
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}
/** update_goal against the exact id and revision the previous get_goal returned. */
const update = (action: string, extra: object = {}) => call('update_goal', (last) => {
  const { goal } = JSON.parse(last) as { goal: { id: string; revision: number } }
  return { goal_id: goal.id, revision: goal.revision, action, ...extra }
})

// ── 业务工具：合成的发布记录 ───────────────────────────────────────────────
const SERVICES = ['order-api', 'payment-api', 'user-api', 'search-api', 'notify-api']
const RELEASES: Record<string, string> = {
  'order-api': 'demo-007 succeeded',
  'payment-api': 'demo-003 failed, rolled back',
  'user-api': 'demo-011 succeeded',
  'search-api': 'demo-005 succeeded',
  'notify-api': 'demo-009 succeeded',
}
const looked: string[] = []
let hang: ((signal: AbortSignal) => Promise<void>) | undefined
const lookupRelease = defineTool({
  name: 'lookup_release',
  description: 'Query the latest synthetic release of one service.',
  parameters: { service: { type: 'string', required: true } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute(args, exec) {
    looked.push(args.service)
    if (hang !== undefined) await hang(exec.signal)
    exec.signal.throwIfAborted()
    return `${args.service}: ${RELEASES[args.service] ?? 'unknown service'}`
  },
})

// ── 宿主 ───────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'dsh-goal-demo-'))
process.on('exit', () => { rmSync(root, { recursive: true, force: true }) })
const agentOptions = { provider: 'mock', model: 'mock' }

async function boot(): Promise<{ ctx: Context; model: ScriptedModel }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  // 和默认 base bundle 一样：模型请求前把日志刷到盘上。
  await ctx.plugin(CheckpointPolicy)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(GoalService)
  await ctx.plugin(ToolGoal)
  await ctx.plugin(GoalRoundDriver)
  const model = new ScriptedModel()
  ctx.llm.registerAdapter(['mock'], model)
  ctx.tools.register(lookupRelease)
  return { ctx, model }
}
let { ctx, model } = await boot()

const human = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
/** Wait until the agent is idle and `done` holds; fail instead of hanging. */
async function settle(agent: Agent, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(agent.status === 'idle' && done())) {
    assert.ok(Date.now() < deadline, `${agent.id} did not settle`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  // 再等一拍，确认驱动器没有再排新的一轮。
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(agent.status, 'idle')
}
// oxlint-disable-next-line typescript/no-deprecated -- the demo reads the whole log on purpose
const events = (agent: Agent): readonly SessionEvent[] => agent.session.snapshotEvents()
const turnCount = (agent: Agent) => events(agent).filter(e => e.type === 'turn/end').length
const goalRounds = (agent: Agent) => events(agent).flatMap(e =>
  e.type === 'user/message' && e.data.source.kind === 'goal' ? [e.data.source.round] : [])
const toolResults = (agent: Agent, name: string) => {
  const names = new Map<string, string>()
  const out: string[] = []
  for (const e of events(agent)) {
    if (e.type === 'tool/call') names.set(e.data.callId, e.data.name)
    if (e.type === 'tool/result') {
      for (const block of e.data.message.content) {
        if (block.type === 'tool-result' && names.get(block.toolCallId) === name) {
          out.push(block.content.map(c => c.type === 'text' ? c.text : '').join(''))
        }
      }
    }
  }
  return out
}
const brief = (agent: Agent) => {
  const goal = ctx.goals.get(agent)
  assert.ok(goal)
  const reason = goal.blockedReason === undefined ? '' : ` reason=${goal.blockedReason.code}`
  return `phase=${goal.phase} rounds=${goal.roundsStarted}/${goal.maxGoalRounds} activation=${goal.activation}${reason}`
}
const OBJECTIVE = '巡检 5 个服务最近一次发布，找出失败的'
const createTurn = (maxRounds: number): Action[] => [
  call('create_goal', () => ({ objective: OBJECTIVE, max_goal_rounds: maxRounds })),
  reply('目标已创建，接下来每轮查一个服务。'),
]
const lookupTurn = (i: number): Action[] => [
  call('lookup_release', () => ({ service: SERVICES[i] })),
  reply(`第 ${i + 1} 个服务查完。`),
]

log('== 1. 巡检：一条人类消息，之后自动续跑 ==')
const patrol = (await ctx.agents.create({ sessionId: SessionId('patrol'), agentOptions })).agent
model.turns.push(
  createTurn(8),
  ...[0, 1, 2, 3].map(lookupTurn),
  [
    call('lookup_release', () => ({ service: SERVICES[4] })),
    call('get_goal', () => ({})),
    update('complete'),
    reply('巡检完成：5 个服务里只有 payment-api 失败，已回滚。'),
  ],
)
patrol.followup(human('巡检一下所有服务最近一次发布'))
await settle(patrol, () => ctx.goals.get(patrol)?.phase === 'complete')
const firstPrompt = events(patrol).find(e => e.type === 'user/message' && e.data.source.kind === 'goal')
assert.ok(firstPrompt?.type === 'user/message')
const promptText = firstPrompt.data.content.map(b => b.type === 'text' ? b.text : '').join('')
assert.match(promptText, /^<goal_round>\nObjective: .*\nRound: 1\/8\n/)
log('第 1 轮的续跑提示（节选）：')
for (const line of promptText.split('\n').slice(0, 3)) log(`  ${line}`)
log(`  ……共 ${promptText.length} 个字符`)
for (const line of toolResults(patrol, 'lookup_release')) log(`lookup_release -> ${line}`)
assert.deepEqual(goalRounds(patrol), [1, 2, 3, 4, 5])
assert.equal(turnCount(patrol), 6)
assert.equal(toolResults(patrol, 'lookup_release').length, 5)
assert.equal(model.turns.length, 0)
const humanMessages = events(patrol).filter(e => e.type === 'user/message' && e.data.source.kind === 'user').length
assert.equal(humanMessages, 1)
log(`人类 ${humanMessages} 条消息，轮次 ${turnCount(patrol)} 个，其中 goal round ${goalRounds(patrol).join(',')}`)
log(`结束：${brief(patrol)}`)
assert.equal(brief(patrol), 'phase=complete rounds=5/8 activation=disarmed')
const notice = events(patrol).find(e => e.type === 'user/message' && e.data.source.kind === 'plugin')
assert.ok(notice?.type === 'user/message')
const noticeText = notice.data.content.map(b => b.type === 'text' ? b.text : '').join('')
assert.ok(noticeText.startsWith('<goal_complete>'))
assert.equal(notice.data.source.kind === 'plugin' ? notice.data.source.plugin : '', 'tool-goal')
log('complete 之后，tool-goal 给模型追加一条收尾提示：')
log(`  ${noticeText.split('\n')[2]!.split('. ')[0]}.`)

log('\n== 2. 只查了 2 个服务就宣布完成 ==')
looked.length = 0
const early = (await ctx.agents.create({ sessionId: SessionId('early'), agentOptions })).agent
model.turns.push(
  createTurn(8),
  lookupTurn(0),
  [
    call('lookup_release', () => ({ service: SERVICES[1] })),
    call('get_goal', () => ({})),
    update('complete'),
    reply('巡检完成。'),
  ],
)
early.followup(human('巡检一下所有服务最近一次发布'))
await settle(early, () => ctx.goals.get(early)?.phase === 'complete')
assert.deepEqual(looked, ['order-api', 'payment-api'])
assert.equal(brief(early), 'phase=complete rounds=2/8 activation=disarmed')
log(`查过的服务：${looked.join(', ')}（清单共 ${SERVICES.length} 个）`)
log(`update_goal complete 被接受：${brief(early)}`)

log('\n== 3. 报告受阻：门槛看的是轮次编号 ==')
const stuck = (await ctx.agents.create({ sessionId: SessionId('stuck'), agentOptions })).agent
const blockedReason = { blocked_reason: '发布记录服务返回 503' }
model.turns.push(
  createTurn(8),
  [call('get_goal', () => ({})), update('blocked', blockedReason), reply('记录服务不可用，下一轮再试。')],
  [reply('这一轮换个话题，整理了已知信息。')],
  [call('get_goal', () => ({})), update('blocked', blockedReason), reply('记录服务仍不可用，需要人工处理。')],
)
stuck.followup(human('巡检一下所有服务最近一次发布'))
await settle(stuck, () => ctx.goals.get(stuck)?.phase === 'blocked')
const blockedTries = toolResults(stuck, 'update_goal')
assert.equal(blockedTries.length, 2)
assert.match(blockedTries[0]!, /blocked requires at least 3 consecutive goal rounds; current round is 1/)
log(`第 1 轮报受阻 -> ${blockedTries[0]}`)
log('第 2 轮没有报受阻')
const third = JSON.parse(blockedTries[1]!) as { goal: { phase: string; roundsStarted: number } }
assert.equal(third.goal.phase, 'blocked')
assert.equal(third.goal.roundsStarted, 3)
log('第 3 轮再报一次 -> 接受（中间第 2 轮没报，谈不上连续）')
log(`  ${brief(stuck)}`)
assert.equal(brief(stuck), 'phase=blocked rounds=3/8 activation=disarmed reason=model-reported')
const quiet = (await ctx.agents.create({ sessionId: SessionId('quiet'), agentOptions })).agent
model.turns.push(
  createTurn(8),
  [reply('记录服务不可用，下一轮再试。')],
  [reply('记录服务还是不可用。')],
  [call('get_goal', () => ({})), update('blocked', blockedReason), reply('需要人工处理。')],
)
quiet.followup(human('巡检一下所有服务最近一次发布'))
await settle(quiet, () => ctx.goals.get(quiet)?.phase === 'blocked')
assert.equal(toolResults(quiet, 'update_goal').length, 1)
assert.equal(brief(quiet), 'phase=blocked rounds=3/8 activation=disarmed reason=model-reported')
log('另一会话前两轮都不报，第 3 轮第一次报 -> 接受')
log(`  ${brief(quiet)}`)

log('\n== 4. 模型一直不收尾：轮数上限 ==')
const endless = (await ctx.agents.create({ sessionId: SessionId('endless'), agentOptions })).agent
model.turns.push(createTurn(3), ...[0, 1, 2].map(lookupTurn))
endless.followup(human('巡检一下所有服务最近一次发布'))
await settle(endless, () => ctx.goals.get(endless)?.phase === 'blocked')
assert.equal(brief(endless), 'phase=blocked rounds=3/3 activation=disarmed reason=round-limit')
assert.equal(turnCount(endless), 4)
assert.deepEqual(goalRounds(endless), [1, 2, 3])
assert.equal(ctx.goals.get(endless)?.blockedReason?.message, 'Goal reached its configured limit of 3 rounds.')
log(`max_goal_rounds 由模型在 create_goal 里给出，这里是 ${ctx.goals.get(endless)?.maxGoalRounds}`)
log(`第 3 轮后：${brief(endless)}`)
log(`  ${ctx.goals.get(endless)?.blockedReason?.message}`)

log('\n== 5. 巡检到一半销毁 Context，恢复后不会自己续跑 ==')
looked.length = 0
const crash = (await ctx.agents.create({ sessionId: SessionId('crash'), agentOptions })).agent
model.turns.push(createTurn(8), lookupTurn(0), [call('lookup_release', () => ({ service: SERVICES[1] }))])
let entered: () => void = () => {}
const inSecondLookup = new Promise<void>((resolve) => { entered = resolve })
hang = async (signal) => {
  if (looked.length < 2) return
  entered()
  await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }) })
}
crash.followup(human('巡检一下所有服务最近一次发布'))
await inSecondLookup
hang = undefined
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? files(path) : [path]
})
const onDisk = files(root).filter(path => path.includes('crash')).map(path => readFileSync(path, 'utf8')).join('')
const roundOnDisk = (n: number) => new RegExp(`"kind":"goal"[^}]*"round":${n}`).test(onDisk)
assert.ok(roundOnDisk(1) && roundOnDisk(2))
log(`卡在第 2 轮查 ${looked.at(-1)}：${brief(crash)}`)
log('  此时盘上的日志已有第 1、2 轮的 goal 消息（checkpoint 插件在模型请求前刷了盘）')
await ctx.fiber.dispose()
;({ ctx, model } = await boot())
const resumed = (await ctx.agents.resume({ resumeSessionId: SessionId('crash'), agentOptions })).agent
assert.equal(brief(resumed), 'phase=active rounds=2/8 activation=disarmed')
log(`新 Context 恢复会话：${brief(resumed)}，agent 状态 ${resumed.status}`)
const interrupted = toolResults(resumed, 'lookup_release')[1]!
assert.match(interrupted, /^The tool call was interrupted/)
log('  第 2 轮的 lookup_release 结果被补写为：')
log(`    ${interrupted.split('. ')[0]}.`)
// 恢复出来的 agent 直接是 idle，不会触发驱动器；用一条插件消息让它跑完一轮再空闲。
model.turns.push([reply('收到。')])
resumed.followup(createUserMessage({
  content: [{ type: 'text', text: '巡检提醒：还有服务没查' }],
  source: { kind: 'plugin', plugin: 'demo', form: 'notice', summary: '巡检提醒' },
}))
await settle(resumed, () => model.requests === 1)
assert.deepEqual(goalRounds(resumed), [1, 2])
assert.equal(brief(resumed), 'phase=active rounds=2/8 activation=disarmed')
log(`插件消息让 agent 跑完一轮再空闲：模型请求 ${model.requests} 次，goal round 仍是 ${goalRounds(resumed).join(',')}`)
model.turns.push(
  [call('get_goal', () => ({})), update('resume'), reply('已恢复，继续巡检。')],
  ...[1, 2, 3].map(lookupTurn),
  [
    call('lookup_release', () => ({ service: SERVICES[4] })),
    call('get_goal', () => ({})),
    update('complete'),
    reply('巡检完成。'),
  ],
)
resumed.followup(human('继续'))
await settle(resumed, () => ctx.goals.get(resumed)?.phase === 'complete')
assert.deepEqual(goalRounds(resumed), [1, 2, 3, 4, 5, 6])
assert.equal(brief(resumed), 'phase=complete rounds=6/8 activation=disarmed')
assert.deepEqual(looked, ['order-api', 'payment-api', 'payment-api', 'user-api', 'search-api', 'notify-api'])
log(`人类说“继续”，模型 update_goal resume 之后：goal round ${goalRounds(resumed).join(',')}`)
log(`  结束：${brief(resumed)}；被中断的第 2 轮计入轮数`)

await ctx.fiber.dispose()
