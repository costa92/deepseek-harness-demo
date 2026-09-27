/** Run the same release patrol as a model-written workflow script and as the fixed Ralph loop, then compare how each fails. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import PtcRuntimeNode from '@deepseek-ai/dsh-ptc-runtime-node'
import PtcWorkflowEngine from '@deepseek-ai/dsh-workflow-ptc'
import * as ToolWorkflow from '@deepseek-ai/dsh-tool-workflow'
import * as ToolRalph from '@deepseek-ai/dsh-tool-ralph'

const log = (msg: string) => { console.log(msg) }

// ── 脚本化模型：父 agent 按轮取动作，子 agent 按任务文字决定动作 ─────────────
type Action = () => StreamChunk[]
const textOf = (message: Message | undefined) => (message?.content ?? [])
  .map(b => b.type === 'text' ? b.text : b.type === 'tool-result' ? b.content.map(c => c.type === 'text' ? c.text : '').join('') : '')
  .join('')
const isToolResult = (message: Message | undefined) => message?.content.some(b => b.type === 'tool-result') === true
const reply = (text: string): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
  { type: 'finish', reason: { kind: 'stop' } },
]
let callSeq = 0
const call = (name: string, args: object): StreamChunk[] => {
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

interface RalphReport { status: string; summary: string; evidence: string[]; nextSteps: string[]; blocker: string }
/** What each Ralph round's worker reports; `fail` makes the worker's model request throw. */
let ralphPlan: (round: number) => RalphReport | 'fail' = () => 'fail'
interface ChildRequest { task: string; tools: string[]; messages: number; roles: string; prompt: string }
const RALPH_WORKER = 'You are one fresh worker in a foreground Ralph loop.'

class ScriptedModel extends LlmAdapter {
  readonly parents = new Map<string, Action[][]>()
  private readonly current = new Map<string, Action[]>()
  readonly childFirst = new Map<string, ChildRequest>()
  /** The host fills this in once the session registry exists. */
  depthOf: (sid: string) => number = () => 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sid = String(options.sessionId)
    const last = options.messages.at(-1)
    const turns = this.parents.get(sid)
    if (turns !== undefined) {
      if (!isToolResult(last)) this.current.set(sid, turns.shift() ?? [])
      const action = this.current.get(sid)?.shift()
      assert.ok(action, `parent ${sid} has no action for: ${textOf(last).slice(0, 60)}`)
      for (const chunk of action()) yield chunk
      return
    }
    const prompt = options.messages.map(textOf).find(t => t.startsWith('查 ') || t.startsWith('嵌套 ') || t.startsWith(RALPH_WORKER))
    assert.ok(prompt, `child ${sid} has no task`)
    if (!this.childFirst.has(sid)) {
      this.childFirst.set(sid, {
        task: prompt.split('\n')[0] ?? '',
        tools: (options.tools ?? []).map(t => t.name),
        messages: options.messages.length,
        roles: options.messages.map(m => m.role).join(','),
        prompt,
      })
    }
    for (const chunk of childStep(sid, prompt, last)) yield chunk
  }
}
function childStep(sid: string, prompt: string, last: Message | undefined): StreamChunk[] {
  if (prompt.startsWith('查 ')) {
    const service = prompt.slice(2)
    // 模型侧故障：这个子 agent 的请求直接失败。
    if (service === 'payment-api') throw new Error('synthetic model outage')
    return isToolResult(last) ? reply(textOf(last)) : call('lookup_release', { service })
  }
  if (prompt.startsWith('嵌套 ')) {
    const depth = model.depthOf(sid)
    if (isToolResult(last)) return reply(`第 ${depth} 层 <- ${textOf(last)}`)
    const left = Number(prompt.slice(3))
    if (left === 0) return call('subagent', { description: 'one more', prompt: '查 order-api' })
    return call('workflow', { script: `return await agent(${JSON.stringify(`嵌套 ${left - 1}`)})`, meta: { name: 'nest', description: 'nest one level' } })
  }
  const round = Number(/Ralph round: (\d+) of/.exec(prompt)?.[1])
  if (isToolResult(last)) return reply(`round ${round} reported`)
  const report = ralphPlan(round)
  if (report === 'fail') throw new Error('synthetic model outage')
  return call('structured_output', report)
}

// ── 业务工具：合成的发布记录 ───────────────────────────────────────────────
const RELEASES: Record<string, string> = {
  'order-api': 'demo-007 succeeded',
  'payment-api': 'demo-003 failed, rolled back',
  'user-api': 'demo-011 succeeded',
}
const lookupRelease = defineTool({
  name: 'lookup_release',
  description: 'Query the latest synthetic release of one service.',
  parameters: { service: { type: 'string', required: true } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: args => Promise.resolve(`${args.service}: ${RELEASES[args.service] ?? 'unknown service'}`),
})

// ── 宿主：与 base bundle 相同的 PTC 进程运行时 + workflow 引擎，外加 ralph ────────
const workspace = mkdtempSync(join(tmpdir(), 'dsh-workflow-demo-'))
process.on('exit', () => { rmSync(workspace, { recursive: true, force: true }) })
const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(LocalSandboxProvider, {})
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
await ctx.plugin(LocalSubprocessRuntime)
await ctx.plugin(LocalFileSystem, { cwd: workspace })
await ctx.plugin(PtcRuntimeNode)
await ctx.plugin(SubagentRuntime)
await ctx.plugin(SpawnProvider, { providerName: 'spawn' })
await ctx.plugin(ToolSubagent, { provider: 'spawn' })
await ctx.plugin(PtcWorkflowEngine, { provider: 'spawn' })
await ctx.plugin(ToolWorkflow)
// base bundle 里这一行是 disabled；这里打开，部署上限设成 5 轮。
await ctx.plugin(ToolRalph, { subagentProvider: 'spawn', maxRounds: 5 })
const model = new ScriptedModel()
ctx.llm.registerAdapter(['mock'], model)
ctx.tools.register(lookupRelease)
model.depthOf = sid => ctx.agents.get(SessionId(sid))?.session.header.delegationDepth ?? 0

async function open(id: string, turns: Action[][]): Promise<Agent> {
  model.parents.set(id, turns)
  return (await ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'mock', model: 'mock' } })).agent
}
const human = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
async function ask(agent: Agent, text: string): Promise<void> {
  agent.followup(human(text))
  await agent.whenIdle()
}
// oxlint-disable-next-line typescript/no-deprecated -- the demo reads the whole log on purpose
const events = (agent: Agent): readonly SessionEvent[] => agent.session.snapshotEvents()
const lastToolResult = (agent: Agent) => {
  const result = events(agent).findLast(e => e.type === 'tool/result')
  assert.ok(result?.type === 'tool/result')
  const block = result.data.message.content.find(b => b.type === 'tool-result')
  assert.ok(block?.type === 'tool-result')
  return { text: block.content.map(c => c.type === 'text' ? c.text : '').join(''), isError: block.isError === true }
}
const SERVICES = Object.keys(RELEASES)
const PATROL_META = { name: 'release-patrol', description: 'Check the latest release of every service.' }

log('== 1. 模型写的 workflow：一个子 agent 失败，整个 run 仍是 completed ==')
const PATROL_SCRIPT = [
  'const results = await parallel(args.services.map(s => () => agent(\'查 \' + s, { label: s })))',
  'return { results, globals: [typeof setTimeout, typeof require, typeof fetch, typeof process] }',
].join('\n')
log('脚本：')
for (const line of PATROL_SCRIPT.split('\n')) log(`  ${line}`)
const wf = await open('wf', [
  [() => call('workflow', { script: PATROL_SCRIPT, meta: PATROL_META, args: { services: SERVICES } }), () => reply('汇总完成。')],
  [() => call('workflow', {
    script: 'return await parallel(args.services.map(s => () => agent(\'查 \' + s, { effort: \'high\' })))',
    meta: PATROL_META,
    args: { services: SERVICES },
  }), () => reply('脚本出错了。')],
])
await ask(wf, '巡检 3 个服务最近一次发布')
const patrol = lastToolResult(wf)
const patrolValue = JSON.parse(patrol.text.slice(patrol.text.indexOf('\n', patrol.text.indexOf('Return value:')) + 1)) as { results: (string | null)[]; globals: string[] }
log(`工具结果首行：${patrol.text.split('\n')[0]}，isError=${patrol.isError}`)
log(`results：${JSON.stringify(patrolValue.results)}`)
log(`脚本里 setTimeout/require/fetch/process：${patrolValue.globals.join(' / ')}`)
assert.equal(patrol.text.split('\n')[0], 'workflow "release-patrol" completed (3 agents).')
assert.equal(patrol.isError, false)
assert.deepEqual(patrolValue.results, ['order-api: demo-007 succeeded', null, 'user-api: demo-011 succeeded'])
assert.deepEqual(patrolValue.globals, ['undefined', 'undefined', 'undefined', 'undefined'])

log('')
log('== 2. 同一个脚本写错一个 agent() 选项：整个 run 失败 ==')
await ask(wf, '再来一次，这次要深入一点')
const typo = lastToolResult(wf)
const typoLines = typo.text.split('\n')
log(`isError=${typo.isError}：${/workflow run failed: /.exec(typoLines[0] ?? '')?.[0]}…`)
log(`  …${/agent\(\) option "effort" is deferred and not supported by this engine/.exec(typoLines[0] ?? '')?.[0]}`)
log(`后面还跟着 ${typoLines.length - 1} 行调用栈，第 1 行：${typoLines[1]?.trim()}`)
assert.equal(typo.isError, true)
assert.match(typoLines[0] ?? '', /^Error: workflow run failed: WorkflowError: agent\(\) option "effort" is deferred and not supported by this engine/)
assert.ok(typoLines.slice(1).every(line => line.trimStart().startsWith('at ')))

log('')
log('== 3. ralph：固定循环，每轮一个全新子 agent，只交接一份报告 ==')
const handoff = (round: number): RalphReport => ({
  status: 'continue', summary: `查完了 ${SERVICES[round - 1]}`, evidence: [`${SERVICES[round - 1]}: ${RELEASES[SERVICES[round - 1] ?? '']}`],
  nextSteps: [`查 ${SERVICES[round]}`], blocker: '',
})
ralphPlan = round => round < 3 ? handoff(round) : { status: 'complete', summary: '3 个服务都查了', evidence: ['都查过了'], nextSteps: [], blocker: '' }
const loop = await open('loop', [
  [() => call('ralph', { objective: '巡检 3 个服务最近一次发布，找出失败的', maxRounds: 4 }), () => reply('Ralph 跑完了。')],
  [() => call('ralph', { objective: '巡检 3 个服务最近一次发布，找出失败的', maxRounds: 4 }), () => reply('第 2 轮失败了。')],
  [() => call('ralph', { objective: '巡检 3 个服务最近一次发布，找出失败的', maxRounds: 4 }), () => reply('报告不合格。')],
  [() => call('ralph', { objective: '巡检 3 个服务最近一次发布，找出失败的', maxRounds: 50 }), () => reply('超出上限。')],
])
const before = new Set(model.childFirst.keys())
await ask(loop, '用 Ralph 循环巡检 3 个服务')
const done = lastToolResult(loop)
const workers = [...model.childFirst.entries()].filter(([id]) => !before.has(id)).map(([, c]) => c)
const doneReport = JSON.parse(done.text.slice(done.text.indexOf('{'))) as RalphReport
log(`工具结果首行：${done.text.split('\n')[0]}`)
log(`最终报告：status=${doneReport.status} evidence=${JSON.stringify(doneReport.evidence)}`)
log(`共 ${workers.length} 个 worker，各自第一次请求的消息数：${workers.map(w => w.messages).join(', ')}`)
const second = workers[1]?.prompt ?? ''
const secondHandoff = second.slice(second.indexOf('Previous structured handoff:\n') + 29).split('\n\n')[0] ?? ''
log(`第 2 轮收到的交接：${secondHandoff.slice(0, 80)}…`)
log(`worker 的工具表里有 ralph：${workers[0]?.tools.includes('ralph')}，有 workflow：${workers[0]?.tools.includes('workflow')}`)
assert.equal(done.text.split('\n')[0], 'Ralph worker reported completion after 3 rounds.')
assert.deepEqual(doneReport.evidence, ['都查过了'])
assert.equal(workers.length, 3)
assert.ok(workers.every(w => w.messages === 3 && w.roles === 'system,user,user'))
assert.ok(workers.every(w => w.task === RALPH_WORKER + ' You receive no parent conversation and no prior child session. Do not call the ralph tool: this round already is its worker.'))
assert.deepEqual(JSON.parse(secondHandoff), handoff(1))
assert.ok(workers.every(w => w.tools.includes('ralph') && w.tools.includes('workflow')))

log('')
log('== 4. ralph 的失败：第 2 轮出错、报告不合格、上限超了 ==')
ralphPlan = round => round === 1 ? handoff(1) : 'fail'
await ask(loop, '再跑一次')
const failed = lastToolResult(loop)
log(`第 2 轮出错 -> isError=${failed.isError}：${failed.text.split('\n')[0]}`)
log(`  下一行：${failed.text.split('\n')[1]}，后面是第 1 轮的报告`)
ralphPlan = () => ({ status: 'complete', summary: '全部正常', evidence: [], nextSteps: [], blocker: '' })
await ask(loop, '再跑一次')
const invalid = lastToolResult(loop)
log(`完成但证据为空 -> isError=${invalid.isError}：`)
log(`  …${/a complete Ralph report[^\n]*/.exec(invalid.text)?.[0]}`)
await ask(loop, '跑 50 轮')
const ceiling = lastToolResult(loop)
log(`maxRounds 50 -> isError=${ceiling.isError}：${ceiling.text}`)
assert.equal(failed.isError, true)
assert.equal(failed.text.split('\n')[0], 'Error: Ralph round 2 child failed before producing a structured report.')
assert.equal(failed.text.split('\n')[1], 'Last successful handoff:')
assert.deepEqual(JSON.parse(failed.text.split('\n').slice(2).join('\n')), handoff(1))
assert.equal(invalid.isError, true)
assert.match(invalid.text, /a complete Ralph report needs evidence, no nextSteps, and an empty blocker/)
assert.equal(ceiling.isError, true)
assert.equal(ceiling.text, 'Error: Ralph maxRounds 50 exceeds the deployment ceiling 5')

log('')
log('== 5. 深度：subagent 工具只许一层，workflow 里套 workflow 不受这个限制 ==')
const nest = await open('nest', [[
  () => call('workflow', { script: 'return await agent(\'嵌套 3\')', meta: { name: 'nest', description: 'nest one level' } }),
  () => reply('嵌套结束。'),
]])
await ask(nest, '一层套一层')
const nested = lastToolResult(nest)
const levels = [...nested.text.matchAll(/第 (\d) 层/g)].map(m => Number(m[1]))
const deepest = [...model.childFirst.entries()].filter(([, c]) => c.task === '嵌套 0').map(([id]) => id)
log(`各层子 agent 的 delegationDepth：${levels.join(' -> ')}`)
log(`第 ${levels.at(-1)} 层用 subagent 再派一个 -> ${/Error: subagent depth \d+ exceeds maxDepth \d+/.exec(nested.text)?.[0]}`)
assert.deepEqual(levels, [1, 2, 3, 4])
assert.equal(deepest.length, 1)
assert.match(nested.text, /Error: subagent depth 5 exceeds maxDepth 1/)
