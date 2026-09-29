/** Workspace instructions for the release duty agent: the AGENTS.md chain, the byte budget, and when edits and nested files reach the model. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import * as AgentInstructions from '@deepseek-ai/dsh-agent-instructions'

const log = (msg: string) => { console.log(msg) }
const root = mkdtempSync(join(tmpdir(), 'dsh-instructions-'))
process.on('exit', () => { rmSync(root, { recursive: true, force: true }) })

// ── 目录布局：值班组的全局规则在 DSH_HOME，发布仓库自带多级 AGENTS.md ────────────────
const dshHome = join(root, 'home/.dsh')
const repo = join(root, 'release-repo')
const bigRepo = join(root, 'big-repo')
function file(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
// 值班组的全局规则约 2.8 KB：第一条是审批，后面是其他值班约定。
const globalRules = `# 值班组全局规则\n部署前必须找值班负责人审批。\n${Array.from({ length: 40 }, (_, i) => `- 约定 ${String(i + 1)}：告警升级前先在值班群里同步一次进展。`).join('\n')}\n`
file(join(dshHome, 'AGENTS.md'), globalRules)
mkdirSync(join(repo, '.git'), { recursive: true })
const repoRules = '# 发布仓库\n发布失败时直接回滚到上一版本，无需审批。\n'
file(join(repo, 'AGENTS.md'), repoRules)
// 和 AGENTS.md 内容相同的 CLAUDE.md。
file(join(repo, 'CLAUDE.md'), `${repoRules}\n`)
file(join(repo, 'services/payment-api/AGENTS.md'), 'payment-api 只在工作日发布。\n')
file(join(repo, 'services/billing/AGENTS.md'), 'billing 的部署可以直接执行，不用问人。\n')
file(join(repo, 'services/billing/notes.md'), '上次发布 2026-09-20\n')
// 另一个仓库：根目录的 AGENTS.md 约 64 KB（例如把发布记录也写了进去），单独放得进 64 KB 预算，加上全局规则就放不下。
mkdirSync(join(bigRepo, '.git'), { recursive: true })
const bigRules = `# 发布记录\n${Array.from({ length: 3360 }, (_, i) => `- release ${String(i).padStart(4, '0')}: ok`).join('\n')}\n`
file(join(bigRepo, 'AGENTS.md'), bigRules)
file(join(bigRepo, 'services/payment-api/AGENTS.md'), 'payment-api 只在工作日发布。\n')

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

// ── 宿主：本地文件系统 + read/write/edit 工具 + agent-instructions（发行版的 64 KB 预算）──
const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
await ctx.plugin(LocalFileSystem, { cwd: root })
await ctx.plugin(toolFs)
await ctx.plugin(AgentInstructions, { dshHome, maxBytes: 65536 })
// 同样按 file_path 读文件，只是名字不叫 read，用来对照。
ctx.tools.register(defineTool({
  name: 'show_file',
  description: 'Show one text file.',
  parameters: { file_path: { type: 'string', required: true } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: args => Promise.resolve(readFileSync(args.file_path, 'utf8')),
}))
await ctx.plugin(AgentLoop, { agents: [] })
const model = new ScriptedModel()
ctx.llm.registerAdapter(['scripted'], model)
const agentOptions = { provider: 'scripted', model: 'mock' }

// ── 工具函数 ────────────────────────────────────────────────────────────────
const text = (message: Message) => message.content.map(b => b.type === 'text' ? b.text : '').join('')
const instructionTexts = (request: GenerateOptions) => request.messages.filter(m => m.source.kind === 'agent-instructions').map(text)
/** Section headers the plugin writes before each file, in order. */
const headers = (value: string) => value.split('\n').filter(line => /^(Instructions from|Additional instructions from|Updated instructions from|Instructions removed): /.test(line))
async function open(id: string, cwd: string): Promise<Agent> {
  return (await ctx.agents.create({ sessionId: SessionId(id), agentOptions, meta: { cwd } })).agent
}
// 每个会话最近一次请求，用来判断下一轮新增了哪些指令段。
const last = new Map<Agent, GenerateOptions>()
async function say(agent: Agent, words: string, ...calls: Call[]): Promise<GenerateOptions[]> {
  const before = model.requests.length
  model.calls.push(...calls)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: words }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const requests = model.requests.slice(before)
  last.set(agent, requests.at(-1) as GenerateOptions)
  return requests
}
/** Instruction sections that first appear in each request of a turn. */
function newHeaders(requests: GenerateOptions[], known: number): string[][] {
  let seen = known
  return requests.map((request) => {
    const all = instructionTexts(request)
    const fresh = all.slice(seen)
    seen = all.length
    return fresh.flatMap(headers)
  })
}
const read = (path: string): Call => ({ name: 'read', args: { file_path: path } })
/** The agent's latest tool result succeeded and carried the notes file, so an empty diff means "not loaded", not "tool failed". */
function lastReadOk(agent: Agent): void {
  const result = agent.session.snapshotEvents().findLast(e => e.type === 'tool/result')
  assert.ok(result?.type === 'tool/result')
  const [block] = result.data.message.content
  assert.notEqual(block.isError, true)
  assert.ok(block.content.some(c => c.type === 'text' && c.text.includes('上次发布 2026-09-20')))
}

log('== 1. 指令链：全局规则、仓库根、会话目录 ==')
const duty = await open('duty', join(repo, 'services/payment-api'))
const [first] = await say(duty, 'payment-api 2.5 发布失败，按规则处理')
assert.ok(first)
const baseline = instructionTexts(first)[0] ?? ''
log(`  第一次请求里的消息来源 | ${first.messages.map(m => m.source.kind).join(', ')}`)
log(`  说明 | ${baseline.split('\n')[1]?.split('. ')[2]}.`)
for (const header of headers(baseline)) log(`  ${header}`)
log(`  仓库根的 CLAUDE.md（与 AGENTS.md 只差一个换行）→ ${baseline.includes('CLAUDE.md') ? '单独渲染' : '没有单独渲染'}`)
assert.deepEqual(first.messages.map(m => m.source.kind), ['plugin', 'user', 'agent-instructions'])
assert.deepEqual(headers(baseline), [
  'Instructions from: $DSH_HOME/AGENTS.md',
  'Instructions from: AGENTS.md',
  'Instructions from: services/payment-api/AGENTS.md',
])
assert.ok(baseline.includes('部署前必须找值班负责人审批') && baseline.includes('无需审批'))
assert.ok(!baseline.includes('CLAUDE.md'))
assert.ok(baseline.includes('More specific instructions take precedence over broader ones.'))

log('\n== 2. 64 KB 预算：仓库根的大文件把全局规则挤掉 ==')
const big = await open('big', join(bigRepo, 'services/payment-api'))
const [bigFirst] = await say(big, 'payment-api 2.5 发布失败，按规则处理')
assert.ok(bigFirst)
const bigBaseline = instructionTexts(bigFirst)[0] ?? ''
log(`  全局规则 ${String(Buffer.byteLength(globalRules))} 字节，仓库根 AGENTS.md ${String(Buffer.byteLength(bigRules))} 字节，渲染后 ${String(Buffer.byteLength(bigBaseline))} 字节`)
log(`  ${bigBaseline.split('\n')[1]}`)
for (const header of headers(bigBaseline)) log(`  ${header}`)
assert.equal(bigBaseline.split('\n')[1], 'Workspace instruction budget 65536 bytes: omitted $DSH_HOME/AGENTS.md')
assert.ok(!bigBaseline.includes('部署前必须找值班负责人审批'))
assert.deepEqual(headers(bigBaseline), ['Instructions from: AGENTS.md', 'Instructions from: services/payment-api/AGENTS.md'])
assert.ok(Buffer.byteLength(bigBaseline) <= 65536)

log('\n== 3. 会话进行中，仓库里的指令文件被改了、被加了 ==')
const known = (agent: Agent) => instructionTexts(last.get(agent) as GenerateOptions).length
// 相当于有人在会话外 git pull：改了一个已加载的文件，又多了一个本地叠加文件。
// 新旧版本长度不同，检测不只靠修改时间。
file(join(repo, 'services/payment-api/AGENTS.md'), 'payment-api 周末也可以发布，需提前报备。\n')
let base = known(duty)
const edited = newHeaders(await say(duty, '继续'), base)
log(`  改了 services/payment-api/AGENTS.md，人发“继续” → ${JSON.stringify(edited.flat())}`)
const both = instructionTexts(last.get(duty) as GenerateOptions).join('\n')
log(`    这次请求里同时有旧版“只在工作日发布”和新版“周末也可以发布”：${String(both.includes('只在工作日发布') && both.includes('周末也可以发布'))}`)
file(join(repo, 'services/payment-api/AGENTS.local.md'), '本机调试：部署命令加 --dry-run。\n')
base = known(duty)
const added = newHeaders(await say(duty, '继续'), base)
log(`  新增 services/payment-api/AGENTS.local.md，人发“继续” → ${JSON.stringify(added.flat())}`)
// services/ 在仓库根和会话目录之间，原本没有指令文件。
file(join(repo, 'services/AGENTS.md'), '所有服务的发布窗口是 10:00-17:00。\n')
base = known(duty)
const between = newHeaders(await say(duty, '继续'), base)
log(`  新增 services/AGENTS.md（原本没有指令文件的中间目录），人发“继续” → ${JSON.stringify(between.flat())}`)
assert.deepEqual(between, [['Additional instructions from: services/AGENTS.md']])
assert.deepEqual(edited, [['Updated instructions from: services/payment-api/AGENTS.md']])
assert.ok(both.includes('只在工作日发布') && both.includes('周末也可以发布'))
assert.deepEqual(added, [['Additional instructions from: services/payment-api/AGENTS.local.md']])

log('\n== 4. 会话目录以下的 AGENTS.md：模型读到那里才加载 ==')
const rootSession = await open('repo-root', repo)
await say(rootSession, '看看仓库')
base = known(rootSession)
const viaShow = newHeaders(await say(rootSession, '看一下 billing 的发布记录', { name: 'show_file', args: { file_path: join(repo, 'services/billing/notes.md') } }), base)
lastReadOk(rootSession)
log(`  cwd=仓库根，用 show_file 读 services/billing/notes.md → ${JSON.stringify(viaShow.flat())}`)
base = known(rootSession)
const nested = newHeaders(await say(rootSession, '再用 read 看一遍', read(join(repo, 'services/billing/notes.md'))), base)
lastReadOk(rootSession)
const nestedText = instructionTexts(model.requests.at(-1) as GenerateOptions).at(-1) ?? ''
log(`  cwd=仓库根，用 read 读同一个文件              → ${JSON.stringify(nested.flat())}`)
log(`    ${String(nestedText.split('\n').find(line => line.startsWith('billing')))}`)
base = known(duty)
const sibling = newHeaders(await say(duty, '顺便看一下 billing', read(join(repo, 'services/billing/notes.md'))), base)
lastReadOk(duty)
log(`  cwd=services/payment-api，用 read 读同一个文件 → ${JSON.stringify(sibling.flat())}`)
assert.deepEqual(viaShow.flat(), [])
// 途经的 services/ 也一起加载。
assert.deepEqual(nested, [[], ['Additional instructions from: services/AGENTS.md', 'Additional instructions from: services/billing/AGENTS.md']])
assert.ok(nestedText.includes('billing 的部署可以直接执行，不用问人。'))
assert.deepEqual(sibling.flat(), [])

await ctx.fiber.dispose()
