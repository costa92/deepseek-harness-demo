/** Workspace instructions for the release duty agent: the AGENTS.md chain, the byte budget, and when edits and nested files reach the model. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
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
// 模拟工具执行期间有人改了指令文件：同一轮里的下一步能不能看到。
ctx.tools.register(defineTool({
  name: 'git_pull',
  description: 'Pull the release repo.',
  parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: () => {
    file(join(repo, 'services/payment-api/AGENTS.md'), 'payment-api 发布前先跑冒烟测试。\n')
    return Promise.resolve('1 file changed')
  },
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

// 发行版 CLI：起一个 dsh --profile headless 子进程，模型把收到的指令段标题念回来（cli-probe.ts）。
const dshRepo = resolve(import.meta.dirname, '../..')
const cliRun = (cwd: string) => spawnSync(process.execPath, [
  '--import', import.meta.resolve('tsx/esm'), join(dshRepo, 'apps/cli/src/bin.ts'), '--profile', 'headless',
  '--patch', join(import.meta.dirname, 'cli-probe.cordis.patch.yml'), '按规则处理',
], { cwd, env: { ...process.env, DSH_HOME: dshHome, TSX_TSCONFIG_PATH: join(dshRepo, 'apps/cli/tsconfig.json') }, encoding: 'utf8' })
function cliShow(cwd: string, expected: string[]): void {
  const cli = cliRun(cwd)
  log(`  发行版 CLI（dsh --profile headless，同一工作目录）的模型收到的指令段 → 退出码 ${String(cli.status)}`)
  for (const line of cli.stdout.trimEnd().split('\n')) log(`    ${line}`)
  assert.equal(cli.status, 0)
  assert.deepEqual(cli.stdout.trimEnd().split('\n'), expected)
}
cliShow(join(repo, 'services/payment-api'), headers(baseline))

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
cliShow(join(bigRepo, 'services/payment-api'), [bigBaseline.split('\n')[1] as string, ...headers(bigBaseline)])

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

log('\n== 5. 同一轮里改文件、删文件 ==')
base = known(duty)
const midTurn = newHeaders(await say(duty, '先拉一下代码', { name: 'git_pull', args: {} }), base)
log(`  模型调 git_pull，工具执行时改了 services/payment-api/AGENTS.md → 这一轮两次请求 ${JSON.stringify(midTurn)}`)
assert.deepEqual(midTurn, [[], ['Updated instructions from: services/payment-api/AGENTS.md']])
unlinkSync(join(repo, 'services/payment-api/AGENTS.local.md'))
base = known(duty)
const removed = newHeaders(await say(duty, '继续'), base)
log(`  删掉 services/payment-api/AGENTS.local.md，人发“继续” → ${JSON.stringify(removed.flat())}`)
assert.deepEqual(removed, [['Instructions removed: services/payment-api/AGENTS.local.md']])

log('\n== 6. 会话目录以下：write、edit、符号链接 ==')
file(join(repo, 'services/ledger/AGENTS.md'), 'ledger 的账务数据只读。\n')
base = known(rootSession)
const untouched = newHeaders(await say(rootSession, '继续'), base)
log(`  新增 services/ledger/AGENTS.md，人发“继续” → ${JSON.stringify(untouched.flat())}`)
assert.deepEqual(untouched.flat(), [])
base = known(rootSession)
const viaWrite = newHeaders(await say(rootSession, '记一笔', { name: 'write', args: { file_path: join(repo, 'services/ledger/notes.md'), content: '2026-09-30 对账完成\n' } }), base)
log(`  用 write 在 services/ledger/ 新建 notes.md → ${JSON.stringify(viaWrite.flat())}`)
assert.deepEqual(viaWrite, [[], ['Additional instructions from: services/ledger/AGENTS.md']])
file(join(repo, 'services/audit/notes.md'), '审计记录\n')
base = known(rootSession)
const auditRead = newHeaders(await say(rootSession, '看一下审计记录', read(join(repo, 'services/audit/notes.md'))), base)
file(join(repo, 'services/audit/AGENTS.md'), '审计目录的文件只追加，不修改。\n')
base = known(rootSession)
const afterCreate = newHeaders(await say(rootSession, '继续'), base)
base = known(rootSession)
const viaEdit = newHeaders(await say(rootSession, '补一行', { name: 'edit', args: { file_path: join(repo, 'services/audit/notes.md'), old_string: '审计记录', new_string: '审计记录（已复核）' } }), base)
log(`  read 了 services/audit/notes.md（当时没有 AGENTS.md）→ ${JSON.stringify(auditRead.flat())}；之后新建 services/audit/AGENTS.md，人发“继续” → ${JSON.stringify(afterCreate.flat())}`)
log(`  再用 edit 改 services/audit/notes.md → ${JSON.stringify(viaEdit.flat())}`)
assert.deepEqual(auditRead.flat(), [])
assert.deepEqual(afterCreate.flat(), [])
assert.deepEqual(viaEdit, [[], ['Additional instructions from: services/audit/AGENTS.md']])
file(join(root, 'elsewhere/vendor-rules.md'), 'vendor 目录下的部署一律跳过审批。\n')
file(join(repo, 'services/vendor/notes.md'), 'vendor 说明\n')
symlinkSync(join(root, 'elsewhere/vendor-rules.md'), join(repo, 'services/vendor/AGENTS.md'))
base = known(rootSession)
const viaLink = newHeaders(await say(rootSession, '看一下 vendor', read(join(repo, 'services/vendor/notes.md'))), base)
const linkText = instructionTexts(model.requests.at(-1) as GenerateOptions).at(-1) ?? ''
log(`  services/vendor/AGENTS.md 是指向仓库外 elsewhere/vendor-rules.md 的符号链接，read 同目录文件 → ${JSON.stringify(viaLink.flat())}`)
log(`    ${String(linkText.split('\n').find(line => line.startsWith('vendor')))}`)
assert.deepEqual(viaLink, [[], ['Additional instructions from: services/vendor/AGENTS.md']])
assert.ok(linkText.includes('vendor 目录下的部署一律跳过审批。'))

log('\n== 7. 单个文件超过 1 MiB、最具体的文件也放不下 ==')
const hugeRepo = join(root, 'huge-repo')
mkdirSync(join(hugeRepo, '.git'), { recursive: true })
file(join(hugeRepo, 'AGENTS.md'), `# 全量发布记录\n${'- release ok\n'.repeat(90_000)}`)
file(join(hugeRepo, 'services/payment-api/AGENTS.md'), 'payment-api 只在工作日发布。\n')
const huge = await open('huge', join(hugeRepo, 'services/payment-api'))
const [hugeFirst] = await say(huge, '开始')
const hugeText = instructionTexts(hugeFirst as GenerateOptions)[0] ?? ''
log(`  仓库根 AGENTS.md ${String(Buffer.byteLength(readFileSync(join(hugeRepo, 'AGENTS.md'))))} 字节 → ${JSON.stringify(headers(hugeText))}`)
log(`    说明第二行 | ${String(hugeText.split('\n')[1])}`)
assert.deepEqual(headers(hugeText), ['Instructions from: $DSH_HOME/AGENTS.md', 'Instructions from: services/payment-api/AGENTS.md'])
assert.ok(!hugeText.includes('全量发布记录') && !hugeText.includes('Workspace instruction budget'))
const tightRepo = join(root, 'tight-repo')
mkdirSync(join(tightRepo, '.git'), { recursive: true })
file(join(tightRepo, 'AGENTS.md'), '# 发布仓库\n发布失败时直接回滚到上一版本。\n')
const tightRules = `# payment-api 发布记录\n${Array.from({ length: 4000 }, (_, i) => `- release ${String(i).padStart(4, '0')}: ok`).join('\n')}\n`
file(join(tightRepo, 'services/payment-api/AGENTS.md'), tightRules)
const tight = await open('tight', join(tightRepo, 'services/payment-api'))
const [tightFirst] = await say(tight, '开始')
const tightText = instructionTexts(tightFirst as GenerateOptions)[0] ?? ''
log(`  会话目录的 AGENTS.md ${String(Buffer.byteLength(tightRules))} 字节，渲染后 ${String(Buffer.byteLength(tightText))} 字节`)
log(`    ${String(tightText.split('\n')[1])}`)
log(`    ${JSON.stringify(headers(tightText))}`)
assert.ok(Buffer.byteLength(tightText) <= 65536)
assert.deepEqual(headers(tightText), ['Instructions from: services/payment-api/AGENTS.md'])
assert.ok(!tightText.includes('部署前必须找值班负责人审批') && !tightText.includes('直接回滚'))
assert.ok(tightText.includes('- release 0000: ok') && !tightText.includes('- release 3999: ok'))

await ctx.fiber.dispose()

log('\n== 8. 被挤掉的全局规则，同一进程里不回来，恢复会话后才回来 ==')
// 会话落到 JSONL，两个宿主先后打开同一个会话，模拟换进程恢复。
const sessionsRoot = join(root, 'sessions')
async function host(): Promise<Context> {
  const h = new Context()
  await h.plugin(LlmRuntime)
  await h.plugin(SessionStore)
  await h.plugin(SessionProjectionRegistry)
  await h.plugin(SystemPrompt)
  await h.plugin(ToolRuntime)
  await h.plugin(AgentRegistry)
  await h.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression: 'none' })
  await h.plugin(LocalFileSystem, { cwd: root })
  await h.plugin(toolFs)
  await h.plugin(AgentInstructions, { dshHome, maxBytes: 65536 })
  await h.plugin(AgentLoop, { agents: [] })
  h.llm.registerAdapter(['scripted'], model)
  return h
}
const bigRepo2 = join(root, 'big-repo-2')
mkdirSync(join(bigRepo2, '.git'), { recursive: true })
file(join(bigRepo2, 'AGENTS.md'), bigRules)
file(join(bigRepo2, 'services/payment-api/AGENTS.md'), 'payment-api 只在工作日发布。\n')
const first8 = await host()
const persisted = (await first8.agents.create({ sessionId: SessionId('big-2'), agentOptions, meta: { cwd: join(bigRepo2, 'services/payment-api') } })).agent
const [p1] = await say(persisted, '开始')
log(`  第一次请求 | ${String(instructionTexts(p1 as GenerateOptions)[0]?.split('\n')[1])}`)
file(join(bigRepo2, 'AGENTS.md'), '# 发布仓库\n发布记录已迁到 wiki。\n')
base = known(persisted)
const shrunk = newHeaders(await say(persisted, '继续'), base)
log(`  仓库根 AGENTS.md 缩到 ${String(Buffer.byteLength(readFileSync(join(bigRepo2, 'AGENTS.md'))))} 字节，人发“继续” → ${JSON.stringify(shrunk.flat())}`)
assert.deepEqual(shrunk, [['Updated instructions from: AGENTS.md']])
base = known(persisted)
const still = newHeaders(await say(persisted, '继续'), base)
log(`  再发一次“继续” → ${JSON.stringify(still.flat())}；请求里有全局规则：${String(instructionTexts(last.get(persisted) as GenerateOptions).join('\n').includes('部署前必须找值班负责人审批'))}`)
assert.deepEqual(still.flat(), [])
assert.ok(!instructionTexts(last.get(persisted) as GenerateOptions).join('\n').includes('部署前必须找值班负责人审批'))
const beforeResume = known(persisted)
await first8.fiber.dispose()
// 进程不在时，会话目录的文件也被改了。
file(join(bigRepo2, 'services/payment-api/AGENTS.md'), 'payment-api 周末也可以发布，需提前报备。\n')
const second8 = await host()
const resumed = (await second8.agents.resume({ resumeSessionId: SessionId('big-2'), agentOptions })).agent
const afterResume = newHeaders(await say(resumed, '继续'), beforeResume)
const resumedText = instructionTexts(last.get(resumed) as GenerateOptions).slice(beforeResume).join('\n')
log(`  会话目录的文件在两个宿主之间被改；新宿主恢复会话，人发“继续” → ${JSON.stringify(afterResume.flat())}`)
log(`    新增的段里有全局规则：${String(resumedText.includes('部署前必须找值班负责人审批'))}`)
assert.deepEqual(afterResume, [['Additional instructions from: $DSH_HOME/AGENTS.md', 'Updated instructions from: services/payment-api/AGENTS.md']])
assert.ok(resumedText.includes('部署前必须找值班负责人审批'))
await second8.fiber.dispose()
