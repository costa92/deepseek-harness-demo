/** Run a release-log shell command under dsh's process sandbox and probe where the boundary is. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { approveEscalation, type EscalationApprover, type EscalationOutcome, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as shellEnv from '@deepseek-ai/dsh-shell-env'
import * as toolBash from '@deepseek-ai/dsh-tool-bash'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'

// 子进程继承这里的 locale；先统一成 C，第 5 步再单独换中文对照。
process.env.LC_ALL = 'C'

// bwrap 会给沙箱换一个私有 /tmp，所以工作区和"工作区外"都建在 HOME 下。
const ws = mkdtempSync(join(homedir(), 'dsh-sandbox-ws-'))
const outside = mkdtempSync(join(homedir(), 'dsh-sandbox-outside-'))
// 会话日志不进沙箱，放系统临时目录。
const sessions = mkdtempSync(join(tmpdir(), 'dsh-sandbox-sessions-'))
process.once('exit', () => {
  rmSync(ws, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  rmSync(sessions, { recursive: true, force: true })
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
// runner 选择在 provider 生命周期内只做一次：先让 bwrap 探测失败，再把它"修好"。
const cacheHost = new Context()
let bwrapUsable = false
let bwrapProbes = 0
const cachedFiber = cacheHost.plugin(LocalSandboxProvider, {})
await cachedFiber
;(cacheHost.sandbox as LocalSandboxProvider).internals.probeBwrap = () => { bwrapProbes++; return bwrapUsable }
const tryConfine = () => cacheHost.sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: ws })
  .then(c => `runner=${c.argv[0]}`, (e: Error & { code?: string }) => e.code ?? e.message)
const verdicts = [await tryConfine()]
log(`  cache: bwrap probe fails            -> ${verdicts[0]}`)
bwrapUsable = true
verdicts.push(await tryConfine())
log(`  cache: bwrap fixed, same provider   -> ${verdicts[1]} (bwrap probed ${bwrapProbes} time)`)
await cachedFiber.dispose()
await cacheHost.plugin(LocalSandboxProvider, {})
verdicts.push(await tryConfine())
log(`  cache: provider plugin reloaded     -> ${verdicts[2]}`)
assert.deepEqual(verdicts, ['SANDBOX_UNAVAILABLE', 'SANDBOX_UNAVAILABLE', 'runner=bwrap'])
assert.equal(bwrapProbes, 1, 'the verdict is cached, the probe never reruns')
await cacheHost.fiber.dispose()

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
// ── 带 agent 的宿主：真实 agent 循环 + dsh-user-approval + JSONL 会话日志 ─────────
/** A model that replays a fixed script: one entry per request. */
class ScriptedModel extends LlmAdapter {
  constructor(private readonly script: StreamChunk[][]) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const entry = this.script.shift()
    assert.ok(entry, 'the scripted model ran out of replies')
    for (const chunk of entry) yield chunk
  }
}
let callSeq = 0
const callBashChunks = (args: object): StreamChunk[] => {
  const id = ToolCallId(`call-${++callSeq}`)
  const json = JSON.stringify({ description: 'pull release errors', ...args })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'bash', argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'bash', arguments: json } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}
const done = (text: string): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const sid = SessionId('sandbox-demo')
const agentOptions = { provider: 'scripted', model: 'mock' }
const answered: string[] = []
const bootHost = async (script: StreamChunk[][]) => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: sessions, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSandboxProvider, {})
  await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: ws })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxBashExecutor, { cwd: ws, timeoutMs: 30_000 })
  await ctx.plugin(shellEnv)
  await ctx.plugin(toolBash)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  // 脚本化的应答器：服务本身从不提示用户，由部署挂的应答器回答；这里每次都批准一次。
  ctx.on('approval/request', (req) => {
    answered.push(req.reason ?? '-')
    return Promise.resolve('allowed-once')
  })
  ctx.llm.registerAdapter(['scripted'], new ScriptedModel(script))
  return ctx
}
const ask = async (ctx: Context, agent: Agent, text: string) => {
  const idle = new Promise<void>((resolve) => {
    const off = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { off(); resolve() }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
  await ctx.sessions.flush(agent.session)
}
const logFile = join(sessions, 'sandbox-demo', 'session.v3.jsonl')
const readEvents = (): SessionEvent[] => {
  const dir = join(sessions)
  const find = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? find(join(d, e.name)) : [join(d, e.name)])
  const file = find(dir).find(f => f.endsWith('.jsonl'))
  assert.ok(file, 'no session log on disk')
  return readFileSync(file, 'utf8').trim().split('\n').slice(1).map(l => JSON.parse(l) as SessionEvent)
}
const resultsSince = (from: number) => readEvents().slice(from).flatMap(e => e.type === 'tool/result'
  ? [{ text: (e.data.message.content[0] as { content: { text?: string }[] }).content.map(c => c.text ?? '').join(''), isError: e.data.message.content[0]?.isError === true }]
  : [])
const firstLine = (text: string) => mask(text.split('\n').find(l => l.startsWith('[sandbox:') || l.startsWith('Error')) ?? text.split('\n')[0] ?? '')

rmSync(report)
let host = await bootHost([
  callBashChunks({ command: PULL }),
  callBashChunks({ command: PULL, sandbox_permissions: 'workspace-write', justification: 'save the error summary into the workspace' }),
  callBashChunks({ command: PULL }),
  done('报告已生成。'),
])
let { agent } = await host.agents.create({ sessionId: sid, meta: { cwd: ws }, agentOptions })
const noAgent = await host.tools.execute({
  callId: ToolCallId('demo-no-agent'), name: 'bash', signal: new AbortController().signal,
  arguments: { description: 'pull release errors', command: PULL, sandbox_permissions: 'workspace-write', justification: 'save the error summary into the workspace' },
})
log(`  via tool, approval service composed, no agent -> ${JSON.stringify(noAgent.error?.message)}`)
assert.equal(noAgent.isError, true)
assert.match(noAgent.error?.message ?? '', /no agent to route/)
assert.ok(!existsSync(report))
log('  real agent loop, dsh-user-approval + a scripted answerer that allows once:')
await ask(host, agent, '把 payment-api 1.4.2 的错误行存成报告')
const loopResults = resultsSince(0)
const labels = ['bash', 'bash + sandbox_permissions', 'bash (same command again)']
loopResults.forEach((r, i) => { log(`    call ${i + 1} ${labels[i]?.padEnd(26)} -> ${firstLine(r.text)}`) })
const audit = readEvents().filter(e => e.type === 'approval/asked' || e.type === 'approval/decided')
log(`    answerer asked ${answered.length} time; session log: ${audit.map(e => e.type === 'approval/decided' ? `${e.type}(${e.data.outcome})` : e.type).join(', ')}`)
assert.equal(loopResults.length, 3)
assert.ok(loopResults[0]?.text.includes('[sandbox: escalation available'))
assert.ok(!loopResults[1]?.isError && !loopResults[1]?.text.includes('[sandbox:'))
assert.ok(loopResults[2]?.text.includes('[sandbox: file access denied under read-only mode]'), 'the grant does not stick: the next call is read-only again')
assert.equal(answered.length, 1)
assert.deepEqual(audit.map(e => e.type), ['approval/asked', 'approval/decided'])
assert.equal(readFileSync(report, 'utf8').split('\n').filter(Boolean).length, 2)

log('8. a session mode switch is one event in the log and survives a restart')
setSandboxMode(agent.session, 'workspace-write')
await host.sessions.flush(agent.session)
const switched = readEvents().filter(e => e.type === 'sandbox/mode')
log(`  log line: ${JSON.stringify({ type: switched[0]?.type, data: switched[0]?.type === 'sandbox/mode' ? switched[0].data : undefined })}`)
assert.equal(switched.length, 1)
await host.fiber.dispose()
rmSync(report)
const before = readEvents().length
host = await bootHost([callBashChunks({ command: PULL }), done('已按会话模式生成报告。')])
;({ agent } = await host.agents.resume({ resumeSessionId: sid, agentOptions }))
log(`  after restart: overrideOf(session)=${host.sandboxPolicy.overrideOf(agent.session)} default=${host.sandboxPolicy.defaultMode}`)
await ask(host, agent, '再生成一次报告')
const [afterRestart] = resultsSince(before)
log(`  bash after restart -> ${JSON.stringify(mask(afterRestart?.text.trim() ?? ''))}, report lines=${readFileSync(report, 'utf8').split('\n').filter(Boolean).length}`)
assert.equal(host.sandboxPolicy.overrideOf(agent.session), 'workspace-write')
assert.ok(afterRestart && !afterRestart.text.includes('[sandbox:'))
assert.equal(answered.length, 1, 'no approval needed: the session mode itself is wider')
await host.fiber.dispose()

log('9. background jobs: the same denial and runner-failure markers, in the job output')
const bg = async (ctx: Context, command: string) => {
  const started = await ctx.tools.execute({
    callId: ToolCallId(`demo-bg-${++seq}`), name: 'bash', signal: new AbortController().signal,
    arguments: { description: 'pull release errors', command, run_in_background: true },
  })
  const jobId = (started.content[0] as { text: string }).text.replace('started background job ', '') as JobId
  await ctx.jobs.wait(jobId, 30_000)
  const read = ctx.jobs.read(jobId)
  return { started: (started.content[0] as { text: string }).text, read }
}
await root.plugin(LocalJobRegistry)
await root.plugin(ToolJobs)
rmSync(report)
const denied = await bg(root, PULL)
log(`  [read-only, bwrap] ${denied.started}; status=${denied.read.snapshot.status} detail=${JSON.stringify(denied.read.snapshot.detail)}`)
log(`${denied.read.text.trim().split('\n').map(l => `    | ${mask(l)}`).join('\n')}`)
assert.ok(denied.read.text.includes('[sandbox: file access denied under read-only mode]'))
assert.ok(denied.read.text.includes('[sandbox: escalation available'))
assert.equal(denied.read.snapshot.status, 'completed')
assert.ok(!existsSync(report))
const broken = new Context()
await broken.plugin(SystemPrompt)
await broken.plugin(ToolRuntime)
await broken.plugin(LocalSandboxProvider, {})
// 只留 Landlock 一档：本机没编译 landlock-run 启动器，runner 本身起不来。
;(broken.sandbox as LocalSandboxProvider).internals.chain = ['landlock']
await broken.plugin(SessionProjectionRegistry)
await broken.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: ws })
await broken.plugin(LocalSubprocessRuntime)
await broken.plugin(SandboxBashExecutor, { cwd: ws, timeoutMs: 30_000 })
await broken.plugin(shellEnv)
await broken.plugin(toolBash)
await broken.plugin(LocalJobRegistry)
await broken.plugin(ToolJobs)
const failed = await bg(broken, `touch ${marker}-bg`)
log(`  [read-only, landlock launcher missing] ${failed.started}; status=${failed.read.snapshot.status} detail=${JSON.stringify(mask(failed.read.snapshot.detail ?? '').slice(0, 120))}`)
if (failed.read.text.trim()) log(`${failed.read.text.trim().split('\n').map(l => `    | ${mask(l)}`).join('\n')}`)
assert.equal(failed.read.snapshot.status, 'killed', 'a runner failure is reported as a signal-less kill, not as failed')
assert.ok(failed.read.text.includes('[sandbox: the sandbox runner itself failed under read-only mode'))
assert.ok(!existsSync(`${marker}-bg`))
await broken.fiber.dispose()

await root.fiber.dispose()
process.exit(0)
