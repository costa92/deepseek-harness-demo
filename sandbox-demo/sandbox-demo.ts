/** Run a release-log shell command under dsh's process sandbox and probe where the boundary is. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { approveEscalation, type EscalationApprover, type EscalationOutcome, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as shellEnv from '@deepseek-ai/dsh-shell-env'
import * as toolBash from '@deepseek-ai/dsh-tool-bash'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

// 子进程继承这里的 locale；先统一成 C，第 5 步再单独换中文对照。
process.env.LC_ALL = 'C'

// bwrap 会给沙箱换一个私有 /tmp，所以工作区和"工作区外"都建在 HOME 下。
const ws = mkdtempSync(join(homedir(), 'dsh-sandbox-ws-'))
const outside = mkdtempSync(join(homedir(), 'dsh-sandbox-outside-'))
process.once('exit', () => {
  rmSync(ws, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})
mkdirSync(join(ws, 'logs'))
mkdirSync(join(ws, 'reports'))
writeFileSync(join(ws, 'logs', 'payment-api-1.4.2.log'), [
  '2026-09-20T10:01:07Z INFO  rollout started demo-003',
  '2026-09-20T10:03:44Z ERROR health check failed: /healthz 503',
  '2026-09-20T10:04:02Z ERROR rollback triggered',
  '',
].join('\n'))
writeFileSync(join(outside, 'deploy.env'), 'DEPLOY_TOKEN=demo-not-a-real-token\n')

const log = (msg: string) => { console.log(msg) }
const mask = (s: string) => s.replaceAll(ws, '<ws>').replaceAll(outside, '<outside>').replaceAll(homedir(), '~')
const PULL = 'grep ERROR logs/payment-api-1.4.2.log > reports/payment-api-errors.txt'
const report = join(ws, 'reports', 'payment-api-errors.txt')

const root = new Context()
await root.plugin(SystemPrompt)
await root.plugin(ToolRuntime)
await root.plugin(LocalSandboxProvider, {})
await root.plugin(SessionProjectionRegistry)
await root.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: ws })
await root.plugin(LocalSubprocessRuntime)
await root.plugin(SandboxBashExecutor, { cwd: ws, timeoutMs: 30_000 })
await root.plugin(shellEnv)
await root.plugin(toolBash)
const bash = root.shell as SandboxBashExecutor
const run = async (command: string, mode?: SandboxMode, env?: Record<string, string>, port?: number) => {
  const r = await bash.run(bash.resolve({
    command,
    ...mode ? { sandboxPolicy: { mode, workspaceRoot: ws } } : {},
    ...env ? { env } : {},
  }))
  const err = r.stderr.text.trim()
  log(`  [${r.sandbox?.mode}] ${mask(port ? command.replace(String(port), '<port>') : command)}`)
  log(`    exit=${r.exitCode} denied=${r.sandbox?.denied}${err ? ` stderr=${JSON.stringify(mask(err))}` : ''}`)
  return r
}
let seq = 0
const callBash = (args: Record<string, unknown>) => root.tools.execute({
  callId: ToolCallId(`demo-${++seq}`), name: 'bash', arguments: { description: 'pull release errors', ...args }, signal: new AbortController().signal,
})

log('1. the provider wraps argv; the policy travels with each call')
const confined = await root.sandbox.confine(['bash', '-c', PULL], { mode: 'workspace-write', workspaceRoot: ws })
log(`  runner=${confined.argv[0]} enforcement=${confined.enforcement} denialSignatures=${JSON.stringify(confined.denialSignatures)}`)
log(`  argv: ${mask(confined.argv.join(' '))}`)
assert.equal(confined.argv[0], 'bwrap', 'this demo expects the bwrap rung (Linux with bubblewrap)')

log('2. read-only (the deployment default): reads pass, the report write is refused')
let r = await run(`grep -c ERROR logs/payment-api-1.4.2.log`)
assert.equal(r.stdout.text.trim(), '2')
r = await run(PULL)
assert.equal(r.sandbox?.denied, true)
assert.ok(!existsSync(report))
let tool = await callBash({ command: PULL })
log(`  model sees:\n${(tool.content[0] as { text: string }).text.split('\n').map(l => `    | ${mask(l)}`).join('\n')}`)

log('3. workspace-write: inside the workspace yes, beside it no, /tmp is private')
r = await run(PULL, 'workspace-write')
assert.equal(r.exitCode, 0)
assert.equal(readFileSync(report, 'utf8').split('\n').filter(Boolean).length, 2)
r = await run(`echo tampered > ${outside}/deploy.env`, 'workspace-write')
assert.equal(r.sandbox?.denied, true)
assert.equal(readFileSync(join(outside, 'deploy.env'), 'utf8'), 'DEPLOY_TOKEN=demo-not-a-real-token\n')
const probe = '/tmp/dsh-sandbox-demo-probe'
assert.equal(existsSync(probe), false)
r = await run(`echo scratch > ${probe} && cat ${probe}`, 'workspace-write')
assert.equal(r.exitCode, 0)
log(`    host sees ${probe}? ${existsSync(probe)}`)
assert.equal(existsSync(probe), false)

log('4. what the modes do not cover: reads, network; processes are hidden by bwrap only')
r = await run(`cat ${outside}/deploy.env`)
assert.equal(r.stdout.text, 'DEPLOY_TOKEN=demo-not-a-real-token\n')
const server = createServer(socket => { socket.end() })
await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
const port = (server.address() as { port: number }).port
r = await run(`exec 3<>/dev/tcp/127.0.0.1/${port} && echo connected`, undefined, undefined, port)
assert.equal(r.stdout.text.trim(), 'connected')
server.close()
r = await run('ps -e --no-headers | wc -l')
log(`    processes visible inside: ${r.stdout.text.trim()}`)
assert.ok(Number(r.stdout.text) < 10)

log('5. "denied" is inferred from stderr text')
r = await run(PULL, 'read-only', { LC_ALL: 'zh_CN.UTF-8' })
if (r.stderr.text.includes('Read-only file system')) {
  log('    (zh_CN.UTF-8 locale not installed here; bash fell back to English)')
} else {
  assert.equal(r.sandbox?.denied, false, 'a translated EROFS message slips past the denial dialect')
  // bash 工具不接受 env 参数，子进程的 locale 来自 dsh 进程本身。
  process.env.LC_ALL = 'zh_CN.UTF-8'
  tool = await callBash({ command: PULL })
  process.env.LC_ALL = 'C'
  const text = (tool.content[0] as { text: string }).text
  log(`  model sees:\n${text.split('\n').map(l => `    | ${mask(l)}`).join('\n')}`)
  assert.ok(!text.includes('[sandbox:'), 'no denial marker, no escalation hint')
}
r = await run(`echo "error: Read-only file system (from our own CLI)" >&2; exit 1`)
assert.equal(r.sandbox?.denied, true, 'any failing command that prints the phrase is classified as a denial')

log('6. fail closed: no usable runner, no unconfined fallback')
const bare = new Context()
await bare.plugin(LocalSandboxProvider, {})
// internals 是包自带的测试钩子：清空 runner 链，模拟一台没有可用沙箱的主机。
;(bare.sandbox as LocalSandboxProvider).internals.chain = []
await bare.plugin(SessionProjectionRegistry)
await bare.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: ws })
await bare.plugin(LocalSubprocessRuntime)
await bare.plugin(SandboxBashExecutor, { cwd: ws, timeoutMs: 30_000 })
const bareBash = bare.shell as SandboxBashExecutor
const marker = join(ws, 'ran-unconfined')
await assert.rejects(bareBash.run(bareBash.resolve({ command: `touch ${marker}` })), (e: Error & { code?: string }) => {
  log(`  read-only -> ${e.code}: ${e.message.split(';')[0]}`)
  return e.code === 'SANDBOX_UNAVAILABLE'
})
assert.ok(!existsSync(marker))
r = await bareBash.run(bareBash.resolve({ command: `touch ${marker}`, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: ws } }))
log(`  danger-full-access -> exit=${r.exitCode} sandbox=${JSON.stringify(r.sandbox)} (provider never consulted)`)
assert.ok(existsSync(marker))
await bare.fiber.dispose()

log('7. escalation: one call, one approval, strictly wider only')
tool = await callBash({ command: PULL, sandbox_permissions: 'workspace-write', justification: 'save the error summary into the workspace' })
log(`  via tool, no approval service -> ${JSON.stringify(tool.error?.message)}`)
assert.equal(tool.isError, true)
const asked: string[] = []
const approver = (outcome: EscalationOutcome): EscalationApprover => ({
  request: req => { asked.push(req.reason); return Promise.resolve(outcome) },
})
const judge = (requestedMode: string, effectiveMode: SandboxMode, outcome: EscalationOutcome = 'allowed-once') =>
  approveEscalation(
    { requestedMode, justification: 'save the error summary into the workspace', effectiveMode, subject: 'command' },
    { approver: approver(outcome), agent: {}, callId: 'demo', toolName: 'bash' },
  ).then(mode => `granted ${mode}`, (e: unknown) => `refused: ${(e as Error).message}`)
for (const [label, verdict] of [
  ['read-only -> read-only       ', await judge('read-only', 'read-only')],
  ['workspace-write -> read-only ', await judge('read-only', 'workspace-write')],
  ['read-only -> workspace-write ', await judge('workspace-write', 'read-only')],
  ['read-only -> workspace-write, user rejects', await judge('workspace-write', 'read-only', 'rejected')],
] as const) log(`  ${label}: ${verdict}`)
assert.equal(asked.length, 2, 'only strictly wider requests reach the user')
log(`  approval prompt reason: ${JSON.stringify(asked[0])}`)
rmSync(report)
r = await run(PULL, 'workspace-write')
assert.equal(r.exitCode, 0)
r = await run(PULL)
assert.equal(r.sandbox?.denied, true, 'the grant does not stick: the next call is read-only again')

await root.fiber.dispose()
process.exit(0)
