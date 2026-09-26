/** Compose a "release on-call" agent from a preset, next to a general one, in one process. */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolRestriction } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets, { livePresetMounts } from '@deepseek-ai/dsh-agent-presets'
import type { Config } from '@deepseek-ai/dsh-agent-presets'

const log = (msg: string) => { console.log(msg) }

/** A model that replays a fixed script and records the tool names each request carried. */
class ScriptedModel extends LlmAdapter {
  readonly script: StreamChunk[][] = []
  readonly requestTools: string[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requestTools.push((options.tools ?? []).map(t => t.name).sort().join(', '))
    const entry = this.script.shift()
    assert.ok(entry, 'the scripted model ran out of replies')
    for (const chunk of entry) yield chunk
  }
}
const reply = (text: string): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const callTool = (rawId: string, name: string): StreamChunk[] => {
  const id = ToolCallId(rawId)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: '{}' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

// ── preset 目录：放在临时根目录里，第 3、5 步要新增和修改文件 ─────────────────
const root = await mkdtemp(join(tmpdir(), 'dsh-preset-demo-'))
// 断言失败时也要清掉临时目录。
process.on('exit', () => { rmSync(root, { recursive: true, force: true }) })
process.env.DSH_HOME = join(root, 'home')
const presets = join(root, 'presets')
const rows = fileURLToPath(new URL('./oncall-rows.ts', import.meta.url))
const runbook = join(presets, 'release-oncall', 'runbook.md')
const oncallYml = join(presets, 'release-oncall', 'agent.cordis.yml')
const mask = (text: string) => text.replaceAll(root, '<tmp>').replaceAll(rows, '<rows>')
const oncall = (extra = '') => [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    prefix: 你是发布值班助手，只查发布记录和执行回滚，不改代码。',
  '- id: oncall',
  `  name: ${rows}`,
  '  config:',
  '    tools: [lookup_release, rollback_release]',
  `    runbook: ${runbook}`,
  extra,
].join('\n')
async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(presets, path)), { recursive: true })
  await writeFile(join(presets, path), text)
}
await put('release-oncall/agent.cordis.yml', oncall())
await put('release-oncall/preset.yml', 'name: 发布值班\ndescription: 只查发布记录和执行回滚。\norder: 1\n')
await put('release-oncall/runbook.md', '回滚前先确认上一个成功版本。\n')
await put('general/agent.cordis.yml', `- id: notes\n  name: ${rows}\n  config:\n    tools: [read_notes]\n`)
await put('deploy-bot/agent.cordis.yml', "- id: deploy\n  name: '@deepseek-ai/dsh-tool-deploy'\n")

// ── 宿主：部署级人设 + 一个挂在全局的 host_shell 工具 ──────────────────────
const hostTool = (name: string) => defineTool({
  name,
  description: `Host-level tool ${name}.`,
  parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: () => Promise.resolve(`${name} ran`),
})

async function host(roster: Config): Promise<Context> {
  const ctx = new Context()
  // 包名行按 baseUrl 解析：apps/cli 的 node_modules 里装有 dsh-persona。
  ctx.baseUrl = pathToFileURL(fileURLToPath(new URL('../../apps/cli/', import.meta.url))).href
  await ctx.plugin(Loader)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '你是通用编码助手。', includeHarnessIdentity: false })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, roster)
  return ctx
}

const ctx = await host({ default: 'general', roots: [{ path: presets, trust: 'system' }], includeShippedRoot: false, includeUserRoot: false })
ctx.tools.register(hostTool('host_shell'))
const model = new ScriptedModel()
ctx.llm.registerAdapter(['mock'], model)

/** Create one session the way a host factory does: join the preset inside `setup`, optionally mask at agent scope. */
async function open(id: string, presetId?: string, agentMask?: ToolRestriction): Promise<Agent> {
  const { agent } = await ctx.agents.create({
    sessionId: SessionId(id),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx: Context) => {
      await ctx.agentPresets.mount(agentCtx, presetId)
      if (agentMask !== undefined) agentCtx.tools.restrict(agentMask)
    },
  })
  return agent
}
const tools = (agent?: Agent) => ctx.tools.schemas(agent).map(s => s.name).sort().join(', ') || '(空)'
const sections = async (agent: Agent) => (await ctx.systemPrompt.assemble(assembleContextFor(agent))).sections
  .filter(s => s.text !== '').map(s => `${s.name}「${s.text}」`)
const mounts = (id: string) => livePresetMounts(ctx.root.fiber).filter(m => m.presetId === id).length
const failure = async (run: Promise<unknown>) => {
  try { await run } catch (e) { return { code: (e as { code?: string }).code, message: mask((e as Error).message) } }
  assert.fail('expected a rejection')
}

log('== 1. 名单：坏的 preset 带着原因列出来 ==')
for (const p of await ctx.agentPresets.list()) {
  log(`${p.id.padEnd(15)} ${p.name ?? '-'}  ${p.broken === undefined ? 'ok' : `broken: ${p.broken}`}`)
}
assert.deepEqual((await ctx.agentPresets.list()).map(p => [p.id, p.broken === undefined]),
  [['release-oncall', true], ['deploy-bot', false], ['general', true]])
const agentsBefore = ctx.agents.list().length
const broken = await failure(open('bad', 'deploy-bot'))
assert.equal(broken.code, 'agent-preset/invalid')
assert.equal(ctx.agents.list().length, agentsBefore)
log(`开 deploy-bot 会话 -> ${broken.code}，没有留下半个会话`)
// 另起一个宿主，只为读取两个开关都不关时的名单。
const full = await host({ default: 'general', roots: [{ path: presets, trust: 'system' }], includeShippedRoot: true, includeUserRoot: true })
const fullIds = (await full.agentPresets.list()).map(p => p.id)
assert.deepEqual(fullIds.slice(0, 4), ['standard', 'ptc', 'minimal', 'cordis'])
log(`不关 includeShippedRoot 时，名单前面多出 4 个随附 preset：${fullIds.slice(0, 4).join(', ')}`)

log('\n== 2. 同一进程里的两个会话 ==')
const s1 = await open('s1', 'release-oncall')
const s2 = await open('s2')
log(`s1 release-oncall 工具：${tools(s1)}`)
log(`s2 general        工具：${tools(s2)}`)
log(`全局视图          工具：${tools()}`)
assert.equal(tools(s1), 'host_shell, lookup_release, rollback_release')
assert.equal(tools(s2), 'host_shell, read_notes')
assert.equal(tools(), 'host_shell')
assert.deepEqual(await sections(s1), [
  'deployment:persona-prefix「你是发布值班助手，只查发布记录和执行回滚，不改代码。」',
  'oncall:runbook「回滚前先确认上一个成功版本。」',
])
assert.deepEqual(await sections(s2), ['deployment:persona-prefix「你是通用编码助手。」'])
for (const [label, agent] of [['s1', s1], ['s2', s2]] as const) {
  log(`${label} 系统提示：`)
  for (const section of await sections(agent)) log(`  ${section}`)
}
const s3 = await open('s3', 'release-oncall')
assert.equal(tools(s3), tools(s1))
assert.equal(mounts('release-oncall'), 1)
log(`s3 也选 release-oncall：常驻挂载仍是 ${mounts('release-oncall')} 份`)

log('\n== 3. 想把宿主工具挡在值班 preset 外面 ==')
const idle = (agent: Agent) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { reject(new Error(`${agent.id} did not go idle within 10s`)) }, 10_000)
  const off = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent && status === 'idle') { clearTimeout(timer); off(); resolve() }
  })
})
/** One turn in which the scripted model calls `tool`; returns the tool result and the first request's tools. */
async function call(agent: Agent, tool: string): Promise<{ result: string; requested: string }> {
  const first = model.requestTools.length
  model.script.push(callTool(`${agent.id}-call`, tool), reply('好的。'))
  const done = idle(agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '查一下 payment-api' }], source: { kind: 'user' } }))
  await done
  // oxlint-disable-next-line typescript/no-deprecated -- the demo reads the whole log on purpose
  const result = agent.session.snapshotEvents().findLast(e => e.type === 'tool/result')
  assert.ok(result?.type === 'tool/result')
  const block = result.data.message.content[0]
  assert.ok(block?.type === 'tool-result')
  return { result: block.content.map(c => c.type === 'text' ? c.text : '').join(''), requested: model.requestTools[first]! }
}
const s1Call = await call(s1, 'host_shell')
assert.equal(s1Call.result, 'host_shell ran')
assert.equal(s1Call.requested, 'host_shell, lookup_release, rollback_release')
log(`s1 调 host_shell -> ${s1Call.result}`)
await put('oncall-deny/agent.cordis.yml', oncall('    restrict: { deny: [host_shell] }\n'))
await put('oncall-allow/agent.cordis.yml', oncall('    restrict: { allow: [] }\n'))
await put('oncall-own/agent.cordis.yml', oncall('    restrict: { allow: [lookup_release, rollback_release] }\n'))
await put('oncall-join/agent.cordis.yml', oncall('    allowOnJoin: [lookup_release, rollback_release]\n'))
const deny = await open('s4', 'oncall-deny')
const denied = await call(deny, 'host_shell')
assert.equal(tools(deny), 'lookup_release, rollback_release')
assert.equal(denied.requested, 'lookup_release, rollback_release')
assert.equal(denied.result, 'Error: unknown tool "host_shell"')
log(`preset 行 restrict { deny: [host_shell] } -> ${tools(deny)}`)
log(`  s4 调 host_shell -> ${denied.result}`)
const allow = await open('s5', 'oncall-allow')
assert.equal(tools(allow), '(空)')
log(`preset 行 restrict { allow: [] }          -> ${tools(allow)}，preset 自己的两个工具也没了`)
const own = await failure(open('bad-own', 'oncall-own'))
assert.equal(own.code, 'agent-preset/invalid')
assert.match(own.message, /names unknown global tools "lookup_release", "rollback_release"; known global tools: host_shell/)
log(`preset 行 restrict { allow: [lookup_release, rollback_release] } -> ${own.code}：`)
log(`  ${/tools\.restrict\(\) names [^\n(]*host_shell/.exec(own.message)![0]}`)
const agentScoped = await open('s6', 'release-oncall', { allow: ['lookup_release', 'rollback_release'] })
assert.equal(tools(agentScoped), 'lookup_release, rollback_release')
const joined = await open('s7', 'oncall-join')
assert.equal(tools(joined), 'lookup_release, rollback_release')
// 注册表视图和提示词组装出的工具列表应当一致。
for (const agent of [s1, deny, allow, agentScoped, joined]) {
  const assembled = (await ctx.systemPrompt.assemble(assembleContextFor(agent))).tools.map(s => s.name).sort().join(', ')
  assert.equal(assembled || '(空)', tools(agent))
}
log(`宿主在 setup 里对 agent 作用域 allow 同样两个名字 -> ${tools(agentScoped)}`)
log(`preset 行监听 agent/created，对 agent 作用域 allow -> ${tools(joined)}`)
ctx.tools.register(hostTool('host_fetch'))
assert.equal(tools(deny), 'host_fetch, lookup_release, rollback_release')
assert.equal(tools(agentScoped), 'lookup_release, rollback_release')
assert.equal(tools(joined), 'lookup_release, rollback_release')
log('宿主后来又注册 host_fetch：')
log(`  preset 行 deny 版          -> ${tools(deny)}`)
log(`  setup 里 allow 版          -> ${tools(agentScoped)}`)
log(`  agent/created 里 allow 版  -> ${tools(joined)}`)

log('\n== 4. 切换 preset ==')
const blank = await open('s8')
const switched = await ctx.agentPresets.select(blank, 'oncall-join')
// oxlint-disable-next-line typescript/no-deprecated -- the demo reads the whole log on purpose
const recorded = blank.session.snapshotEvents().filter(e => e.type === 'agent-preset/selected').map(e => e.data)
assert.deepEqual(recorded, [{ agentPreset: 'oncall-join' }])
assert.equal(ctx.agentPresets.composedPreset(blank.ctx), 'oncall-join')
// 切换只改父作用域，不会再发 agent/created，oncall-join 的白名单落不到这个会话上。
assert.equal(tools(blank), 'host_fetch, host_shell, lookup_release, rollback_release')
log(`空会话 ${blank.id} 切到 ${switched} -> ${tools(blank)}`)
log('  直接用 oncall-join 建的 s7 只有两个工具；切换进来的没有收到 agent/created，白名单没生效')
log(`  日志记下 agent-preset/selected ${JSON.stringify(recorded[0])}`)
const lockedSwitch = await failure(ctx.agentPresets.select(s1, 'general'))
assert.equal(lockedSwitch.code, 'agent-preset/locked')
assert.equal(ctx.agentPresets.composedPreset(s1.ctx), 'release-oncall')
log(`s1 已经跑过一轮，再切 -> ${lockedSwitch.code}：${lockedSwitch.message}`)

log('\n== 5. 改 preset 目录里的文件 ==')
const runbookOf = async (agent: Agent) => (await ctx.systemPrompt.assemble(assembleContextFor(agent)))
  .sections.find(s => s.name === 'oncall:runbook')?.text
await writeFile(runbook, '回滚前先确认上一个成功版本，并在群里通知。\n')
const afterRunbook = await open('s9', 'release-oncall')
assert.equal(await runbookOf(afterRunbook), '回滚前先确认上一个成功版本。')
assert.equal(mounts('release-oncall'), 1)
log(`只改 runbook.md，新会话 ${afterRunbook.id} 看到：${await runbookOf(afterRunbook)}（常驻挂载 ${mounts('release-oncall')} 份）`)
await utimes(oncallYml, new Date(), new Date(Date.now() + 60_000))
const afterTouch = await open('s10', 'release-oncall')
assert.equal(await runbookOf(afterTouch), '回滚前先确认上一个成功版本，并在群里通知。')
assert.equal(await runbookOf(s1), '回滚前先确认上一个成功版本。')
assert.equal(mounts('release-oncall'), 2)
log(`再 touch agent.cordis.yml，新会话 ${afterTouch.id} 看到：${await runbookOf(afterTouch)}`)
log(`  s1 仍是：${await runbookOf(s1)}（常驻挂载变成 ${mounts('release-oncall')} 份，旧的一份不回收）`)

