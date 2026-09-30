/** Seam vs core: swap the fs provider under tool-fs, then probe the ctx.tools registry contract. */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import PtcRuntimeNode from '@deepseek-ai/dsh-ptc-runtime-node'

const log = (msg: string) => { console.log(msg) }
// 插件重载是异步的：按条件等，而不是固定让出几拍。
const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 1000; i++) {
    if (cond()) return
    await new Promise(r => setImmediate(r))
  }
  throw new Error(`timed out waiting for ${what}`)
}
const names = (ctx: Context, scope?: object) => ctx.tools.schemas(scope).map(t => t.name).sort().join(',') || '(none)'
const params = (ctx: Context, tool: string) => Object.keys((ctx.tools.get(tool)?.parameters as { properties?: object } | undefined)?.properties ?? {}).join(',')
let seq = 0
const call = (ctx: Context, name: string, args: unknown, agent?: object) => ctx.tools.execute({
  callId: ToolCallId(`demo-${++seq}`), name, arguments: args, signal: new AbortController().signal,
  ...(agent ? { agent: agent as never } : {}),
})

const dir = await mkdtemp(join(tmpdir(), 'dsh-tools-demo-'))
process.once('exit', () => { rmSync(dir, { recursive: true, force: true }) })
const root = new Context()
await root.plugin(SystemPrompt)
await root.plugin(ToolRuntime)

log('1. seam: tool-fs consumes ctx.fs, it never picks a provider')
root.plugin(toolFs)
log(`  without any ctx.fs provider: tools=${names(root)}`)
assert.equal(names(root), '(none)')
const local = root.plugin(LocalFileSystem, { cwd: dir })
await until(() => names(root) === 'edit,read,write', 'tool-fs to register over fs-local')
log(`  + fs-local: tools=${names(root)} sandboxMode=${root.fs.sandboxMode}`)
assert.equal(root.fs.sandboxMode, undefined)
log(`  write params: ${params(root, 'write')}`)
assert.equal(params(root, 'write'), 'file_path,content')
const target = join(dir, 'note.txt')
let r = await call(root, 'write', { file_path: target, content: 'hello' })
log(`  write via fs-local -> isError=${r.isError} ${r.isError ? JSON.stringify(r.content) : ''}`)
assert.equal(r.isError, false)

log('2. swap the provider, keep the consumer')
await local.dispose()
await until(() => names(root) === '(none)', 'tool-fs to unregister after fs-local left')
log(`  fs-local disposed: tools=${names(root)}`)
root.plugin(SessionProjections)
root.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: dir })
root.plugin(SandboxedFileSystem, { cwd: dir })
await until(() => params(root, 'write').includes('sandbox_permissions'), 'tool-fs to re-register over fs-sandbox')
log(`  + fs-sandbox(read-only): tools=${names(root)} sandboxMode=${root.fs.sandboxMode}`)
assert.equal(names(root), 'edit,read,write')
assert.equal(root.fs.sandboxMode, 'read-only')
log(`  write params: ${params(root, 'write')}`)
assert.equal(params(root, 'write'), 'file_path,content,sandbox_permissions,justification')
r = await call(root, 'write', { file_path: target, content: 'again' })
log(`  write via fs-sandbox -> isError=${r.isError} code=${r.error?.info?.code}`)
log(`  model sees: ${JSON.stringify(r.content).slice(0, 160)}`)
assert.equal(r.error?.info?.code, 'FS_SANDBOX_DENIED')

log('3. core: ctx.tools refuses a tool without an output contract')
assert.throws(() => {
  try {
    root.tools.register({ name: 'no_output', description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => ({}) } as never)
  } catch (e) {
    log(`  ${(e as Error).name}: ${(e as Error).message}`)
    throw e
  }
}, TypeError)

log('4. what the model sees: schemas() keeps only name/description/parameters')
const recordSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    service: { type: 'string', required: true },
    version: { type: 'string', required: true },
    status: { type: 'string', enum: ['succeeded', 'failed'], required: true },
  },
} as const
interface Release { id: string; service: string; version: string; status: 'succeeded' | 'failed' }
let source: Release[] = [{ id: 'demo-003', service: 'payment-api', version: '1.4.2', status: 'failed' }]
const lookup = (description: string) => defineTool({
  name: 'lookup_release',
  description,
  timeoutMs: 5000,
  parameters: { service: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { records: { type: 'array', items: recordSchema, required: true } } },
    render: (_args, value) => [{ type: 'text', text: `${value.records.length} record(s)` }],
  },
  async execute(args) {
    return { records: source.filter(x => x.service === args.service) }
  },
})
root.tools.register(lookup('global release lookup'))
const schema = root.tools.schemas().find(t => t.name === 'lookup_release')
assert.ok(schema)
log(`  schema keys: ${Object.keys(schema).join(',')}`)
assert.deepEqual(Object.keys(schema), ['name', 'description', 'parameters'])

log('5. output schema is enforced on every successful value')
r = await call(root, 'lookup_release', { service: 'payment-api' })
log(`  clean source -> isError=${r.isError} content=${JSON.stringify(r.content)} value=${JSON.stringify(r.value)}`)
assert.equal(r.isError, false)
// 模拟上游接口某天开始多返回审批人邮箱：运行时数据不受 TS 类型约束，这里用断言绕过类型检查。
source = [{ ...source[0], approver: 'alice@example.com' } as Release]
r = await call(root, 'lookup_release', { service: 'payment-api' })
log(`  leaky source -> isError=${r.isError} code=${r.error?.info?.code}`)
log(`  model sees: ${JSON.stringify(r.content)}`)
assert.equal(r.error?.info?.code, 'INVALID_TOOL_OUTPUT')
assert.ok(!JSON.stringify(r.content).includes('alice@example.com'))

log('6. scope: an agent-scoped registration shadows the global one')
const agentA = { id: 'agent-A' }
// createScope 继承调用方插件的依赖 API，所以得在声明了 inject: ['tools'] 的插件里建。
let scoped!: ReturnType<typeof createScope>
let hostCtx!: Context
await root.plugin({ name: 'agent-host', inject: ['tools'], apply(ctx: Context) { hostCtx = ctx; scoped = createScope(ctx, agentA) } })
scoped.ctx.tools.register(lookup('on-call preset: production only'))
log(`  global view : ${root.tools.get('lookup_release')?.description}`)
log(`  agent-A view: ${root.tools.get('lookup_release', agentA)?.description}`)
assert.equal(root.tools.get('lookup_release')?.description, 'global release lookup')
assert.equal(root.tools.get('lookup_release', agentA)?.description, 'on-call preset: production only')
scoped.ctx.tools.restrict({ deny: ['edit'] })
log(`  agent-A tools=${names(root, agentA)}`)
log(`  global  tools=${names(root)}`)
assert.equal(names(root, agentA), 'lookup_release,read,write')
assert.equal(names(root), 'edit,lookup_release,read,write')
r = await call(root, 'edit', { file_path: target, old_string: 'a', new_string: 'b' }, agentA)
log(`  agent-A calls edit -> isError=${r.isError} code=${r.error?.info?.code}`)
assert.equal(r.error?.info?.code, 'UNKNOWN_TOOL')

log('7. registrations are effects of the registering fiber')
let changes = 0
root.on('tools/change', () => { changes++ })
await scoped.dispose()
log(`  scope disposed: tools/change fired ${changes}x, agent-A view=${root.tools.get('lookup_release', agentA)?.description}, agent-A tools=${names(root, agentA)}`)
assert.equal(changes, 2)
assert.equal(root.tools.get('lookup_release', agentA)?.description, 'global release lookup')
assert.equal(names(root, agentA), 'edit,lookup_release,read,write')

log('8. fs-sandbox escalation: one approved wider retry')
const asked: string[] = []
// 审批服务的桩：只记下请求并批准一次，不走真实的 dsh-user-approval（它要求处于打开的回合里）。
root.provide('approval', { request: async (req: { toolName: string; reason: string }) => { asked.push(`${req.toolName}: ${req.reason}`); return 'allowed-once' } })
const agentE = { id: 'agent-E' }
r = await call(root, 'write', { file_path: target, content: 'escalated', sandbox_permissions: 'workspace-write', justification: 'save the on-call note' }, agentE)
log(`  approval asked: ${asked.join(' | ')}`)
log(`  escalated write -> isError=${r.isError}`)
assert.deepEqual(asked, ['write: escalate sandbox to workspace-write: save the on-call note'])
assert.equal(r.isError, false)
r = await call(root, 'write', { file_path: target, content: 'plain' }, agentE)
log(`  next write without escalation -> isError=${r.isError} code=${r.error?.info?.code}`)
assert.equal(r.error?.info?.code, 'FS_SANDBOX_DENIED')

log('9. restrict() hard checks, and tools/change is not scope-filtered')
const agentB = { id: 'agent-B' }
const scopeA = createScope(hostCtx, agentA)
const scopeB = createScope(hostCtx, agentB)
const restrictError = (label: string, fn: () => unknown) => {
  try { fn() } catch (e) { log(`  ${label} -> ${(e as Error).message.split(/[:;]/)[0]}`); return }
  assert.fail(`${label} did not throw`)
}
restrictError('root.restrict({ deny: [edit] })', () => root.tools.restrict({ deny: ['edit'] }))
restrictError('scoped.restrict({})', () => scopeA.ctx.tools.restrict({}))
restrictError('scoped.restrict({ deny: [nope] })', () => scopeA.ctx.tools.restrict({ deny: ['nope'] }))
let seenByB = 0
scopeB.ctx.on('tools/change', () => { seenByB++ })
scopeA.ctx.tools.register(lookup('agent-A only'))
log(`  agent-A registers a scoped tool -> agent-B listener fired ${seenByB}x, agent-B view=${root.tools.get('lookup_release', agentB)?.description}`)
assert.equal(seenByB, 1)
assert.equal(root.tools.get('lookup_release', agentB)?.description, 'global release lookup')
await scopeA.dispose()
await scopeB.dispose()

log('10. a real agent step: what the model request carries')
class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly script: StreamChunk[][] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    assert.ok(entry, 'the scripted model ran out of replies')
    for (const chunk of entry) yield chunk
  }
}
const host = new Context()
await host.plugin(LlmRuntime)
await host.plugin(SessionStore)
await host.plugin(SessionProjections)
await host.plugin(SystemPrompt)
await host.plugin(ToolRuntime)
await host.plugin(AgentRegistry)
const model = new ScriptedModel()
host.llm.registerAdapter(['mock'], model)
// 第 5 步把数据源改成了带 approver 的脏数据，这里换回干净记录。
source = [{ id: 'demo-003', service: 'payment-api', version: '1.4.2', status: 'failed' }]
const concurrent = { ...lookup('global release lookup'), isConcurrencySafe: () => true }
host.tools.register(concurrent)
await host.plugin(AgentLoop, { agents: [] })
const argsJson = JSON.stringify({ service: 'payment-api' })
const toolId = ToolCallId('call-1')
model.script.push([
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: toolId, name: 'lookup_release', argumentsDelta: argsJson },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: toolId, name: 'lookup_release', arguments: argsJson } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
], [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'done' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
  { type: 'finish', reason: { kind: 'stop' } },
])
// 第一步执行工具时再注册一个工具，看第二步的请求里有没有它。
host.on('tools/post-execute', async (exec, _result, next) => {
  if (exec.name === 'lookup_release') host.tools.register(defineTool({
    name: 'late_tool', description: 'registered mid-turn', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [{ type: 'text', text: 'ok' }] },
    async execute() { return {} },
  }))
  return next()
})
const { agent } = await host.agents.create({ sessionId: SessionId('tools-demo'), agentOptions: { provider: 'mock', model: 'mock' } })
agent.followup(createUserMessage({ content: [{ type: 'text', text: 'payment-api?' }], source: { kind: 'user' } }))
await agent.whenIdle()
const [req1, req2] = model.requests
const sent = req1?.tools?.find(t => t.name === 'lookup_release')
log(`  request 1 tools: ${req1?.tools?.map(t => t.name).join(',')}; lookup_release keys: ${Object.keys(sent ?? {}).join(',')}`)
log(`  request 2 tools: ${req2?.tools?.map(t => t.name).join(',')}`)
assert.deepEqual(Object.keys(sent ?? {}), ['name', 'description', 'parameters'])
assert.ok(!JSON.stringify(req1).includes('5000'))
assert.deepEqual(req2?.tools?.map(t => t.name), ['late_tool', 'lookup_release'])
// oxlint-disable-next-line typescript/no-deprecated -- the demo reads the whole log on purpose
const logged = JSON.stringify(agent.session.snapshotEvents())
log(`  session events contain the value's "demo-003"? ${logged.includes('demo-003')}; contain the rendered "1 record(s)"? ${logged.includes('1 record(s)')}`)
assert.ok(!logged.includes('demo-003'))
assert.ok(logged.includes('1 record(s)'))
await host.fiber.dispose()

log('11. PTC mode: the SDK declaration carries the output shape')
const ptc = new Context()
await ptc.plugin(SessionProjections)
await ptc.plugin(SystemPrompt)
await ptc.plugin(ToolRuntime, { mode: 'ptc' })
await ptc.plugin(LocalSandboxProvider, {})
await ptc.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: dir })
await ptc.plugin(LocalSubprocessRuntime)
await ptc.plugin(LocalFileSystem, { cwd: dir })
await ptc.plugin(PtcRuntimeNode)
await until(() => ptc.get('ptcRuntime') !== undefined, 'the PTC runtime')
ptc.tools.register(lookup('global release lookup'))
const assembled = await ptc.systemPrompt.assemble({})
const sdk = assembled.sections.map(x => x.text).join('\n')
const outputMap = sdk.slice(sdk.indexOf('interface ToolOutputMap'), sdk.indexOf('type ToolName'))
log(`  model tools: ${assembled.tools.map(t => t.name).join(',')}`)
log('  system prompt SDK declares:')
for (const line of outputMap.trimEnd().split('\n')) log(`    ${line}`)
assert.deepEqual(assembled.tools.map(t => t.name), ['run_code'])
assert.ok(outputMap.includes('records: ({'))
assert.ok(outputMap.includes('status: "succeeded" | "failed";'))
await ptc.fiber.dispose()

process.exit(0)
