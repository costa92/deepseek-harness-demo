/** Drive a "patrol every service's latest release" goal through dsh-goal, dsh-tool-goal and the round driver. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
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
// 第 5 步会用同一个脚本起一个子进程（设了 GOAL_DEMO_CHILD_ROOT），在里面跑到一半被 SIGKILL。
const childRoot = process.env.GOAL_DEMO_CHILD_ROOT
const root = childRoot ?? mkdtempSync(join(tmpdir(), 'dsh-goal-demo-'))
if (childRoot === undefined) process.on('exit', () => { rmSync(root, { recursive: true, force: true }) })
const agentOptions = { provider: 'mock', model: 'mock' }

async function boot(checkpoint = true): Promise<{ ctx: Context; model: ScriptedModel }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  // 和默认 base bundle 一样：模型请求前把日志刷到盘上。
  if (checkpoint) await ctx.plugin(CheckpointPolicy)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(GoalService)
  await ctx.plugin(ToolGoal)
  await ctx.plugin(GoalRoundDriver)
  const model = new ScriptedModel()
  ctx.llm.registerAdapter(['mock'], model)
  ctx.tools.register(lookupRelease)
  return { ctx, model }
}
let { ctx, model } = await boot(childRoot === undefined)

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
const pluginMessage = (text: string) => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'plugin', plugin: 'demo', form: 'notice', summary: text },
})

if (childRoot !== undefined) {
  // 子进程：不挂 checkpoint 插件，卡在第 2 轮查 payment-api 时告诉父进程，然后等着被杀。
  const killed = (await ctx.agents.create({ sessionId: SessionId('killed'), agentOptions })).agent
  model.turns.push(createTurn(8), lookupTurn(0), [call('lookup_release', () => ({ service: SERVICES[1] }))])
  hang = async () => {
    if (looked.length < 2) return
    console.log(`HANG ${brief(killed)}`)
    await new Promise(() => {})
  }
  killed.followup(human('巡检一下所有服务最近一次发布'))
  setInterval(() => {}, 1_000)
  await new Promise(() => {})
}

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
// 另一会话：驱动器刚把第 1 轮排进收件箱，同一拍里插进一条插件消息。
const cutin = (await ctx.agents.create({ sessionId: SessionId('cutin'), agentOptions })).agent
const queuedRounds: number[] = []
let cutDone = false
ctx.on('agent/inbox/inserted', ({ agent, message }) => {
  if (agent !== cutin || message.source.kind !== 'goal') return
  queuedRounds.push(message.source.round)
  if (cutDone) return
  cutDone = true
  cutin.followup(pluginMessage('插话：先看一眼告警'))
})
const claimed: string[] = []
ctx.on('agent/inbox/claimed', ({ agent, message }) => {
  if (agent === cutin) claimed.push(message.source.kind === 'goal' ? `goal round ${message.source.round}` : message.source.kind)
})
model.turns.push(
  createTurn(8),
  [reply('告警看过了。')],
  [call('get_goal', () => ({})), update('complete'), reply('巡检完成。')],
)
cutin.followup(human('巡检一下所有服务最近一次发布'))
await settle(cutin, () => ctx.goals.get(cutin)?.phase === 'complete')
const cutinOrder = events(cutin).flatMap(e => e.type === 'user/message'
  ? [e.data.source.kind === 'goal' ? `goal round ${e.data.source.round}` : e.data.source.kind] : [])
assert.deepEqual(queuedRounds, [1, 1])
assert.deepEqual(claimed, ['user', 'goal round 1', 'plugin', 'goal round 1', 'plugin'])
assert.deepEqual(cutinOrder, ['user', 'plugin', 'goal round 1', 'plugin'])
assert.equal(brief(cutin), 'phase=complete rounds=1/8 activation=disarmed')
log('另一会话：驱动器排进第 1 轮的同时，插进一条插件消息')
log(`  第 1 轮 goal 消息排队 ${queuedRounds.length} 次，领取顺序：${claimed.join(', ')}`)
log(`  日志里的消息：${cutinOrder.join(', ')}`)
log(`  结束：${brief(cutin)}`)

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
const told = (await ctx.agents.create({ sessionId: SessionId('told'), agentOptions })).agent
model.turns.push([
  call('create_goal', () => ({ objective: OBJECTIVE, max_goal_rounds: 8 })),
  call('get_goal', () => ({})),
  update('blocked', blockedReason),
  reply('按你说的，标记为受阻。'),
])
told.followup(human('巡检一下所有服务最近一次发布；记录服务在维护，先标记受阻'))
await settle(told, () => ctx.goals.get(told)?.phase === 'blocked')
assert.equal(brief(told), 'phase=blocked rounds=0/8 activation=disarmed reason=model-reported')
assert.deepEqual(goalRounds(told), [])
log(`人类那一轮直接要求标记受阻 -> 接受：${brief(told)}`)

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
// 按 session-controller 的 fork 写法：取到最后一个完整轮次为止的日志当种子。
const parentEvents = events(crash)
const cut = parentEvents.findLastIndex(e => e.type === 'turn/end') + 1
const forked = (await ctx.agents.create({
  sessionId: SessionId('forked'),
  seed: parentEvents.slice(0, cut),
  inheritedEventCount: SessionLogOffset(cut),
  meta: { parentSession: crash.session.id, isSeeded: true },
  agentOptions,
})).agent
model.turns.push([reply('收到。')])
forked.followup(pluginMessage('巡检提醒：还有服务没查'))
await settle(forked, () => turnCount(forked) > parentEvents.slice(0, cut).filter(e => e.type === 'turn/end').length)
assert.equal(brief(forked), 'phase=active rounds=1/8 activation=disarmed')
assert.deepEqual(goalRounds(forked), [1])
log(`从第 1 轮结束处 fork：${brief(forked)}`)
log(`  插件消息让 fork 跑完一轮再空闲：goal round 仍是 ${goalRounds(forked).join(',')}`)
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
model.turns.push([call('get_goal', () => ({})), update('resume'), reply('收到。')])
resumed.followup(pluginMessage('巡检提醒：还有服务没查'))
await settle(resumed, () => model.requests === 3)
const resumeTry = toolResults(resumed, 'update_goal')
assert.deepEqual(resumeTry, ['Error: this goal operation requires a direct human turn on a top-level agent'])
log(`插件消息那一轮，模型 update_goal resume -> ${resumeTry[0]}`)
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
// 子进程不挂 checkpoint 插件，卡在第 2 轮时被 SIGKILL，再在本进程恢复。
const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!], {
  env: { ...process.env, GOAL_DEMO_CHILD_ROOT: root },
  stdio: ['ignore', 'pipe', 'inherit'],
})
const hungLine = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => { reject(new Error('child did not reach round 2')) }, 20_000)
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const line = buffer.split('\n').find(l => l.startsWith('HANG '))
    if (line !== undefined) { clearTimeout(timer); resolve(line.slice(5)) }
  })
})
const exited = new Promise<NodeJS.Signals | null>((resolve) => { child.on('exit', (_code, signal) => { resolve(signal) }) })
child.kill('SIGKILL')
const signal = await exited
const killedAgent = (await ctx.agents.resume({ resumeSessionId: SessionId('killed'), agentOptions })).agent
assert.equal(hungLine, 'phase=active rounds=2/8 activation=armed')
assert.equal(signal, 'SIGKILL')
assert.equal(brief(killedAgent), 'phase=active rounds=1/8 activation=disarmed')
assert.deepEqual(goalRounds(killedAgent), [1])
assert.deepEqual(toolResults(killedAgent, 'lookup_release'), ['order-api: demo-007 succeeded'])
log(`子进程不挂 checkpoint 插件，卡在第 2 轮时：${hungLine}`)
log(`  ${signal} 后在本进程恢复：${brief(killedAgent)}，日志里只有第 1 轮`)

await ctx.fiber.dispose()
