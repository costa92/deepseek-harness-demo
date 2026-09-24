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
await root.plugin({ name: 'agent-host', inject: ['tools'], apply(ctx: Context) { scoped = createScope(ctx, agentA) } })
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

process.exit(0)
