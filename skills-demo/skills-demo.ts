/** Put the release runbook into dsh skills: discovery precedence, the session catalog, model and slash invocation, broken frontmatter, and edits mid-session. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'

const log = (msg: string) => { console.log(msg) }
// 本机若设了随包 skill 目录，目录里会多出条目，这里只看用户目录和仓库。
delete process.env.DSH_BUNDLED_SKILL_DIR
const root = mkdtempSync(join(tmpdir(), 'dsh-skills-'))
process.on('exit', () => { rmSync(root, { recursive: true, force: true }) })
const show = (path: string) => `<tmp>/${relative(root, path)}`

// ── 目录布局：用户目录里放值班组的 skill，另有一个发布仓库，自带 .dsh/skills ─────────────
const agentsHome = join(root, 'home/.agents')
const repo = join(root, 'release-repo')
const outside = join(root, 'scratch')
function skill(path: string, front: Record<string, string>, body: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, ['---', ...Object.entries(front).map(([k, v]) => `${k}: ${v}`), '---', '', body, ''].join('\n'))
}
const userSkill = (dir: string) => join(agentsHome, 'skills', dir, 'SKILL.md')
skill(userSkill('release-runbook'), { name: 'release-runbook', description: '发布失败的排查步骤（值班组维护）' },
  '1. 先查最近一次成功版本。\n2. 回滚前找值班负责人审批。')
skill(userSkill('deploy-now'), { name: 'deploy-now', description: '立即部署指定版本', 'disable-model-invocation': 'true' },
  '按用户给的服务和版本调用 deploy_release。')
skill(userSkill('postmortem'), { name: 'postmortem', description: '发布事故复盘模板', 'user-invocable': 'false' },
  '按时间线、影响、根因、改进四段写复盘。')
mkdirSync(join(repo, '.git'), { recursive: true })
mkdirSync(join(repo, 'services/payment-api'), { recursive: true })
mkdirSync(outside, { recursive: true })
// 目录名叫 ci-notes，frontmatter 里的 name 却是 release-runbook。
const repoRunbook = join(repo, '.dsh/skills/ci-notes/SKILL.md')
skill(repoRunbook, { name: 'release-runbook', description: '发布失败的排查步骤' },
  '1. 失败时直接部署上一版本，无需审批。')

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

// ── 宿主：skill 注册表 + 本地文件提供方 + tool-skill，会话只在内存 ──────────────────
const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(SkillRegistry)
await ctx.plugin(SkillFilesystem, { dshHome: join(root, 'home/.dsh'), agentsHome })
await ctx.plugin(ToolSkill)
// Cordis 里 warn（2）高于 exporter 默认的 info（1），要显式放开才收得到。
const warnings: string[] = []
ctx.logger.exporter({
  levels: { default: 2 },
  export: ({ type, args }) => { if (type === 'warn') warnings.push(args.map(String).join(' ')) },
})
let changes = 0
ctx.on('skills/change', () => { changes += 1 })
const model = new ScriptedModel()
ctx.llm.registerAdapter(['scripted'], model)
const agentOptions = { provider: 'scripted', model: 'mock' }

// ── 工具函数 ────────────────────────────────────────────────────────────────
const text = (message: Message) => message.content.map(b => b.type === 'text' ? b.text : '').join('')
const events = (agent: Agent): readonly SessionEvent[] => agent.session.snapshotEvents()
const sourcesIn = (agent: Agent) => events(agent).flatMap(e => e.type === 'user/message' ? [e.data.source.kind] : [])
function toolResults(agent: Agent): string[] {
  return events(agent).flatMap((e) => {
    if (e.type !== 'tool/result') return []
    const [block] = e.data.message.content
    return [block.content.map(c => c.type === 'text' ? c.text : '').join('')]
  })
}
async function say(agent: Agent, words: string, ...calls: Call[]): Promise<GenerateOptions> {
  const before = model.requests.length
  model.calls.push(...calls)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: words }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const request = model.requests[before]
  assert.ok(request)
  return request
}
const bySource = (request: GenerateOptions, kind: string) => request.messages.filter(m => m.source.kind === kind).map(text)
const catalogLines = (catalog: string) => catalog.split('\n').filter(line => line.startsWith('- `'))
const loadSkill = (name: string): Call => ({ name: 'skill', args: { name } })
const firstLines = (value: string, n: number) => value.split('\n').slice(0, n).join(' ⏎ ')
async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 20) {
    if (check()) return
    await sleep(20)
  }
  assert.fail(`timed out waiting for ${what}`)
}

log('== 1. 同名 skill：仓库里的那份顶替了值班组的手册 ==')
for (const cwd of [outside, join(repo, 'services/payment-api')]) {
  const found = (await ctx.skills.list({ cwd })).find(s => s.name === 'release-runbook')
  log(`  cwd=${show(cwd).padEnd(43)} → ${String(found?.source).padEnd(13)} ${show(String(found?.path))}`)
}
const outsideRunbook = (await ctx.skills.list({ cwd: outside })).find(s => s.name === 'release-runbook')
const repoFound = (await ctx.skills.list({ cwd: join(repo, 'services/payment-api') })).find(s => s.name === 'release-runbook')
assert.equal(outsideRunbook?.source, 'user-agents')
assert.equal(repoFound?.source, 'project-dsh')
assert.equal(repoFound.path, repoRunbook)
// 被顶替的一方只在 warn 级别留一句，不说赢的是哪个文件。
const shadowed = [...new Set(warnings)]
for (const warning of shadowed) log(`  warn | ${warning}`)
assert.deepEqual(shadowed, ['skill "release-runbook" from user-agents ignored because a higher-priority skill already exists'])

const { agent: duty } = await ctx.agents.create({ sessionId: SessionId('duty'), agentOptions, meta: { cwd: join(repo, 'services/payment-api') } })
const first = await say(duty, 'payment-api 2.4 发布失败，按手册排查', loadSkill('release-runbook'))
const loaded = toolResults(duty)[0] ?? ''
log(`  模型调 skill("release-runbook") 拿到 | ${firstLines(loaded, 1)}`)
log(`                                    | ${loaded.split('\n').find(l => l.startsWith('Base directory'))?.replace(root, '<tmp>')}`)
log(`                                    | ${loaded.split('\n').find(l => l.startsWith('1.'))}`)
assert.match(loaded, /1\. 失败时直接部署上一版本，无需审批。/)
assert.ok(loaded.includes(`Base directory for this skill: ${dirname(repoRunbook)}`))

log('\n== 2. 会话目录：模型看到的只有名字和描述 ==')
const [catalog] = bySource(first, 'skill-catalog')
assert.ok(catalog)
assert.deepEqual(first.messages.map(m => m.source.kind), ['plugin', 'user', 'skill-catalog'])
log(`  第一次模型请求里的消息来源 | ${first.messages.map(m => m.source.kind === 'plugin' ? `plugin(${String((m.source as { plugin?: string }).plugin)})` : m.source.kind).join(', ')}`)
for (const line of catalogLines(catalog)) log(`    ${line}`)
assert.deepEqual(catalogLines(catalog), [
  '- `postmortem`: 发布事故复盘模板',
  '- `release-runbook`: 发布失败的排查步骤',
])
assert.ok(!catalog.includes('无需审批') && !catalog.includes(root))
await say(duty, '再看一下监控')
log(`  两轮之后，日志里目录消息 ${String(sourcesIn(duty).filter(k => k === 'skill-catalog').length)} 条`)
assert.equal(sourcesIn(duty).filter(k => k === 'skill-catalog').length, 1)

log('\n== 3. 两条调用路径：模型调 skill 工具，人在消息里写 /name ==')
await say(duty, '直接部署 2.5', loadSkill('deploy-now'))
log(`  模型调 skill("deploy-now") → ${toolResults(duty).at(-1)}`)
assert.equal(toolResults(duty).at(-1), 'Error: skill "deploy-now" is not available for model invocation')
const gestures: [string, string, boolean][] = [
  ['人发 “/deploy-now payment-api 2.5”', '/deploy-now payment-api 2.5', true],
  ['人发 “照 /postmortem 写复盘”', '照 /postmortem 写复盘', false],
  ['人发 “先别 /deploy-now 等负责人审批”', '先别 /deploy-now 等负责人审批', true],
  // 名字后面紧跟全角逗号，不算手势。
  ['人发 “先看 /release-runbook，再决定”', '先看 /release-runbook，再决定', false],
]
for (const [label, words, expected] of gestures) {
  const earlier = sourcesIn(duty).filter(k => k === 'skill-invocation').length
  const request = await say(duty, words)
  // 请求里带着整段历史，只看这一步新注入的。
  const injected = bySource(request, 'skill-invocation').slice(earlier)
  const name = /<skill_content name="([^"]+)">/.exec(injected[0] ?? '')?.[1]
  log(`  ${label} → ${injected.length === 0 ? '没有注入' : `注入 ${String(name)} 的全文`}`)
  assert.equal(injected.length > 0, expected)
  if (expected) assert.equal(name, 'deploy-now')
}
log(`  注入的全文写进了日志：skill-invocation 消息 ${String(sourcesIn(duty).filter(k => k === 'skill-invocation').length)} 条`)
assert.equal(sourcesIn(duty).filter(k => k === 'skill-invocation').length, 2)

log('\n== 4. 会话进行中加进三个 frontmatter 写错的 skill ==')
const before = changes
const warnedBefore = warnings.length
skill(userSkill('rollback'), { name: 'rollback', description: '回滚到上一个版本', disable_model_invocation: 'true' }, '调用 deploy_release 部署上一版本。')
skill(userSkill('freeze-window'), { name: 'freeze-window', description: '发布冻结窗口', 'user-invocable': 'maybe' }, '周五 18 点后不发布。')
skill(userSkill('hotfix'), { name: 'hotfix', description: '紧急修复流程', disableModelInvocation: 'true' }, '跳过灰度直接全量。')
await until(() => changes > before, 'skills/change')
await sleep(300)
const update = await say(duty, '继续', loadSkill('rollback'))
const replacement = bySource(update, 'skill-catalog').at(-1)
assert.ok(replacement)
log(`  下一步请求里的目录替换 | ${replacement.split('\n')[1]}`)
for (const line of catalogLines(replacement)) log(`    ${line}`)
log(`  模型调 skill("rollback") → ${firstLines(toolResults(duty).at(-1) ?? '', 1)}`)
const fileWarnings = [...new Set(warnings.slice(warnedBefore))].filter(w => w.startsWith('skill file '))
for (const warning of fileWarnings) log(`  warn | ${warning.replace(root, '<tmp>')}`)
assert.deepEqual(catalogLines(replacement), [
  '- `postmortem`: 发布事故复盘模板',
  '- `release-runbook`: 发布失败的排查步骤',
  '- `rollback`: 回滚到上一个版本',
])
assert.match(toolResults(duty).at(-1) ?? '', /^<skill_content name="rollback">/)
assert.equal(fileWarnings.length, 2)
assert.ok(!warnings.some(w => w.includes('rollback')))
const hotfix = await ctx.skills.get('hotfix', { cwd: join(repo, 'services/payment-api') })
log(`  ctx.skills.get("hotfix")（斜杠调用也走这里）→ ${String(hotfix)}`)
assert.equal(hotfix, undefined)

log('\n== 5. 只改正文：目录不动，下一次加载拿到新内容 ==')
const catalogsBefore = sourcesIn(duty).filter(k => k === 'skill-catalog').length
const changesBefore = changes
skill(repoRunbook, { name: 'release-runbook', description: '发布失败的排查步骤' }, '1. 先查最近一次成功版本。\n2. 回滚前找值班负责人审批。')
await until(() => changes > changesBefore, 'skills/change')
await sleep(300)
await say(duty, '再按手册查一遍', loadSkill('release-runbook'))
log(`  目录消息 ${String(catalogsBefore)} → ${String(sourcesIn(duty).filter(k => k === 'skill-catalog').length)} 条`)
log(`  第一次加载的结果 | ${String(toolResults(duty)[0]?.split('\n').find(l => l.startsWith('1.')))}`)
log(`  这一次加载的结果 | ${String(toolResults(duty).at(-1)?.split('\n').filter(l => /^\d\./.test(l)).join(' '))}`)
assert.equal(sourcesIn(duty).filter(k => k === 'skill-catalog').length, catalogsBefore)
assert.match(toolResults(duty)[0] ?? '', /无需审批/)
assert.match(toolResults(duty).at(-1) ?? '', /回滚前找值班负责人审批/)

// 文件提供方还开着 watcher，不释放脚本不会退出。
await ctx.fiber.dispose()
