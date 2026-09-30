/** Drive the release duty agent from outside the dsh process: headless one-shot runs, then the TypeScript SDK over stdio JSON-RPC. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { zstdDecompressSync } from 'node:zlib'
import { scanZstdFrames } from '../../packages/session/session-persistence-jsonl/src/zstd.ts'
import { DeepSeekHarness, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-client'
import type { HarnessNotification, RunResult } from '@deepseek-ai/dsh-sdk-client'

const log = (msg: string) => { console.log(msg) }
const demo = import.meta.dirname
const repo = resolve(demo, '../..')
// 从源码启动 dsh：bin.ts 要 tsx 加载，SDK 的源码启动还要多叠一层 sdk-source 补丁（apps/cli/src/sdk-source.cordis.patch.yml）。
const tsx = import.meta.resolve('tsx/esm')
const bin = join(repo, 'apps/cli/src/bin.ts')
const patch = (file: string) => join(demo, file)
// 所有临时目录退出时都删，断言失败中途退出也不留下。
const temps: string[] = []
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}
const work = temp('dsh-duty-work-')
const other = temp('dsh-duty-other-')
const home = temp('dsh-duty-home-')
process.on('exit', () => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }) })

const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home, TSX_TSCONFIG_PATH: join(repo, 'apps/cli/tsconfig.json') }
delete env.DSH_PERMISSION_MODE
const redact = (s: string) => s.replaceAll(work, '<work>').replaceAll(other, '<other>')
  .replace(/session-[0-9a-f]{8}-[0-9a-f-]{27}/g, 'session-<uuid>')

// ── headless：每次起一个 dsh 进程，任务从命令行进，答案从 stdout 出 ──────────────────
interface Exit { code: number | null; stdout: string; stderr: string }
function headless(args: string[], cwd = work, patches: string[] = [], extra: NodeJS.ProcessEnv = {}): Exit {
  const out = spawnSync(process.execPath, [
    '--import', tsx, bin, '--profile', 'headless',
    ...['duty.cordis.patch.yml', ...patches].flatMap(file => ['--patch', patch(file)]),
    ...args,
  ], { cwd, env: { ...env, ...extra }, encoding: 'utf8' })
  return { code: out.status, stdout: out.stdout, stderr: out.stderr }
}
function show(title: string, run: Exit): void {
  log(`${title} → 退出码 ${String(run.code)}`)
  for (const [name, text] of [['stdout', run.stdout], ['stderr', run.stderr]] as const) {
    for (const line of text.replace(/\n$/, '').split('\n')) log(`  ${name} | ${line === '' ? '（空行）' : redact(line)}`)
  }
}
// 读 DSH_HOME 里的会话日志：目录按工作目录分组，日志是多个 zstd 帧拼接。
const sessionDirs = () => readdirSync(join(home, 'sessions')).flatMap(group => readdirSync(join(home, 'sessions', group)).map(id => ({ id, dir: join(home, 'sessions', group, id) })))
const sessionIds = () => new Set(sessionDirs().map(s => s.id))
function sessionLog(id: string): { type: string; data: Record<string, unknown> }[] {
  const found = sessionDirs().find(s => s.id === id)
  assert.ok(found !== undefined, `no session ${id}`)
  const bytes = readFileSync(join(found.dir, 'session.v3.jsonl.zstd'))
  return scanZstdFrames(bytes).frames
    .flatMap(f => zstdDecompressSync(bytes.subarray(f.start, f.end)).toString().trim().split('\n'))
    .map(line => JSON.parse(line) as { type: string; data: Record<string, unknown> })
    .filter(e => e.type !== 'session')
}
/** Run one headless process and return the single session it created. */
function fresh(args: string[], patches: string[] = [], extra: NodeJS.ProcessEnv = {}): Exit & { session: string } {
  const before = sessionIds()
  const run = headless(args, work, patches, extra)
  const created = [...sessionIds()].filter(id => !before.has(id))
  assert.equal(created.length, 1)
  return { ...run, session: created[0] ?? '' }
}
const permissionFacts = (id: string) => sessionLog(id)
  .filter(e => ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(e.type))
  .map(e => `${e.type}=${String(Object.values(e.data)[0])}`).join(' ')
const approvalTrail = (id: string) => sessionLog(id).filter(e => e.type.startsWith('approval/') && e.type !== 'approval/policy')
  .map(e => e.type === 'approval/decided' ? `decided:${String(e.data.outcome)}` : 'asked').join(' → ')
const ledger = () => {
  const file = join(work, 'deploys.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []
}

log('== 1. headless：一次性任务的输出与退出码 ==')
const query = headless(['查询 payment-api'])
show('查询 payment-api', query)
assert.equal(query.code, 0)
assert.equal(query.stdout, '已完成：payment-api 最近一次发布 2.2，状态 succeeded\n')
assert.equal(query.stderr, 'dsh: reasoning:\n按剧本回答\n')
const down = headless(['模型故障'])
show('模型故障', down)
assert.equal(down.code, 1)
assert.equal(down.stdout, '\n')
assert.equal(down.stderr, 'dsh: UNKNOWN: scripted provider is down\n')
const blank = headless(['查询后空回复'])
show('最后一步只回空文字', blank)
assert.equal(blank.code, 0)
assert.equal(blank.stdout, '先查一下发布记录\n')

log('\n== 2. headless 部署：审批没人应答 ==')
const NO_CHANNEL = 'Error: tool "deploy_release" requires approval, but no approval channel is available'
const deploy = fresh(['部署 payment-api 2.4'])
show('部署 payment-api 2.4', deploy)
assert.equal(deploy.code, 0)
assert.equal(deploy.stdout, `没有执行：${NO_CHANNEL}\n`)
log(`部署账本：${ledger().length} 行`)
assert.deepEqual(ledger(), [])

const json = headless(['--json', '部署 payment-api 2.4'])
const events = json.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
log(`--json → 退出码 ${String(json.code)}，${events.length} 个事件：${events.map(e => e.type).join(' ')}`)
const result = events.find(e => e.type === 'tool_result')
const turnEnd = events.find(e => e.phase === 'turn_end')
log(`  tool_result | ${JSON.stringify(result)}`)
log(`  turn_end    | ${JSON.stringify(turnEnd?.reason)}`)
assert.equal(json.code, 0)
assert.equal(events.some(e => String(e.type).includes('approval')), false)
assert.equal(result?.status, 'error')
assert.deepEqual(turnEnd?.reason, { kind: 'completed' })

const REJECTED = '没有执行：Error: the user rejected tool "deploy_release"\n'
const never = fresh(['部署 payment-api 2.4'], ['ci.cordis.patch.yml'])
show('叠加 ci.cordis.patch.yml 后部署', never)
log(`  会话日志 | ${permissionFacts(never.session)}；审批 ${approvalTrail(never.session)}`)
assert.equal(never.code, 0)
assert.equal(never.stdout, REJECTED)
assert.equal(permissionFacts(never.session), 'permission/preset=ci sandbox/mode=workspace-write approval/policy=never')
assert.equal(approvalTrail(never.session), 'asked → decided:rejected')
assert.deepEqual(ledger(), [])

// ci 权限预设只在新会话创建时写进日志：接旧会话看的是旧会话自己的记录。
const oldWithCi = headless(['--session-id', deploy.session, '部署 payment-api 2.4'], work, ['ci.cordis.patch.yml'])
show('叠加 ci 补丁接上不带补丁时建的会话', oldWithCi)
assert.equal(oldWithCi.stdout, `没有执行：${NO_CHANNEL}\n`)
const ciWithout = headless(['--session-id', never.session, '部署 payment-api 2.4'])
show('不带补丁接上 ci 下建的会话', ciWithout)
assert.equal(ciWithout.stdout, REJECTED)
const danger = fresh(['部署 payment-api 2.4'], [], { DSH_PERMISSION_MODE: 'danger-full-access' })
show('DSH_PERMISSION_MODE=danger-full-access 下部署', danger)
log(`  会话日志 | ${permissionFacts(danger.session)}；审批 ${approvalTrail(danger.session)}`)
assert.equal(danger.stdout, REJECTED)
assert.equal(permissionFacts(danger.session), 'permission/preset=danger-full-access sandbox/mode=danger-full-access approval/policy=never')
assert.deepEqual(ledger(), [])

log('\n== 3. --session-id：下一个进程接着这段对话 ==')
const sessionId = String(events[0]?.sessionId)
log(`上一节 --json 报告的会话：${redact(sessionId)}`)
const resumed = headless(['--session-id', sessionId, '你好'])
show('同一目录 --session-id', resumed)
assert.equal(resumed.code, 0)
assert.match(resumed.stdout, /这是本会话第 2 条用户消息/)
const unknown = headless(['--session-id', 'session-nope', '你好'])
show('不存在的 id', unknown)
assert.equal(unknown.code, 1)
const moved = headless(['--session-id', sessionId, '你好'], other)
show('换一个工作目录', moved)
assert.equal(moved.code, 1)
assert.match(moved.stderr, /was recorded in/)

// ── SDK：一个 dsh 子进程常驻，stdio 上跑 JSON-RPC ─────────────────────────────────
function harness(options: { bridge?: string; timeoutMs?: number; provider?: string } = {}): DeepSeekHarness {
  return new DeepSeekHarness({
    dshBin: bin,
    patches: [
      join(repo, 'apps/cli/src/sdk-source.cordis.patch.yml'),
      patch('duty.cordis.patch.yml'),
      ...options.bridge === undefined ? [] : [patch('bridge.cordis.patch.yml')],
    ],
    dshHome: home,
    processCwd: work,
    cwd: work,
    provider: options.provider ?? 'scripted',
    model: 'mock',
    env: {
      ...env,
      NODE_OPTIONS: `--import ${tsx}`,
      ...options.bridge === undefined ? {} : { DUTY_APPROVAL_DIR: options.bridge, DUTY_APPROVAL_TIMEOUT_MS: String(options.timeoutMs ?? 1000) },
    },
    initializeTimeoutMs: 60_000,
  })
}
type Event = { type: string; data: Record<string, unknown> }
const eventOf = (n: HarnessNotification) => n.method === 'session.event' ? n.params.event as Event : undefined
const eventsOf = (run: RunResult) => run.events as unknown as Event[]
const approvalsOf = (run: RunResult) => eventsOf(run).filter(e => e.type.startsWith('approval/'))

log('\n== 4. SDK：审批请求传到了客户端，但客户端答不了 ==')
{
  await using sdk = harness()
  const asked: Record<string, unknown>[] = []
  const run = await sdk.run('部署 payment-api 2.4', {
    sessionId: 'duty-1',
    onNotification(n) {
      const event = eventOf(n)
      if (event?.type === 'approval/asked') asked.push(event.data)
    },
  })
  const { id: _id, ...question } = asked[0] ?? {}
  log('部署 payment-api 2.4')
  log(`  运行中收到 approval/asked | ${JSON.stringify(question)}`)
  log(`  approval/decided          | ${String(approvalsOf(run)[1]?.data.outcome)}`)
  log(`  finalResponse             | ${run.finalResponse}`)
  log(`  RunResult 的字段          | ${Object.keys(run).join(', ')}`)
  assert.equal(asked.length, 1)
  assert.deepEqual(question, { toolName: 'deploy_release', callId: 'call-1', reason: '部署 payment-api 2.4 需要值班人确认' })
  assert.deepEqual(approvalsOf(run).map(e => e.type), ['approval/asked', 'approval/decided'])
  assert.equal(approvalsOf(run)[1]?.data.outcome, 'unavailable')
  assert.equal(run.finalResponse, `没有执行：${NO_CHANNEL}`)
  assert.deepEqual(ledger(), [])

  const failed = await sdk.run('模型故障', { sessionId: 'duty-1' })
  const end = eventsOf(failed).findLast(e => e.type === 'turn/end')
  log('模型故障')
  log(`  run() 正常返回，finalResponse | ${JSON.stringify(failed.finalResponse)}`)
  log(`  turn/end.reason               | ${JSON.stringify(end?.data.reason)}`)
  assert.equal(failed.finalResponse, '')
  assert.equal((end?.data.reason as { kind: string }).kind, 'error')

  const blankRun = await sdk.run('查询后空回复', { sessionId: 'duty-blank' })
  log(`最后一步只回空文字，finalResponse | ${JSON.stringify(blankRun.finalResponse)}`)
  assert.equal(blankRun.finalResponse, '')

  // SDK 子进程还开着 duty-1，另一个进程来接。
  const locked = headless(['--session-id', 'duty-1', '接着查'])
  show('SDK 进程还开着 duty-1 时 headless --session-id duty-1', locked)
  assert.equal(locked.code, 1)
}
{
  await using nope = harness({ provider: 'nope' })
  const error = await nope.run('你好', { sessionId: 'duty-nope' }).then(() => undefined, (e: unknown) => e)
  log(`provider 没有注册适配器 | ${(error as Error).constructor.name}: ${(error as Error).message}`)
  assert.ok(error instanceof JsonRpcResponseError)
  assert.equal(error.message, 'no adapter registered for provider "nope"')
}
{
  await using again = harness()
  const error = await again.run('接着查', { sessionId: 'duty-1' }).then(() => undefined, (e: unknown) => e)
  log(`新 SDK 进程用同一个 sessionId | ${(error as Error).constructor.name}: ${(error as Error).message}`)
  assert.ok(error instanceof JsonRpcResponseError)
  assert.equal(error.message, 'session "duty-1" already exists')
}
const adopted = headless(['--session-id', 'duty-1', '接着查'])
show('headless --session-id duty-1', adopted)
assert.equal(adopted.code, 0)
assert.match(adopted.stdout, /这是本会话第 3 条用户消息/)

log('\n== 5. 审批桥：子进程里挂应答者，答案由客户端写文件 ==')
{
  const dir = temp('dsh-duty-approvals-')
  await using sdk = harness({ bridge: dir })
  // 值班人的规则：2.3 在黑名单里，2.5 不回答（模拟人不在）。
  const reviewer = (args: { version: string }) => args.version === '2.3' ? 'reject' : args.version === '2.5' ? undefined : 'allow'
  // 参数取自审批之前写入的 tool/call 事件；通知覆盖整棵会话树，键里带上会话。
  const callArgs = new Map<string, { version: string }>()
  const onNotification = (n: HarnessNotification) => {
    const event = eventOf(n)
    const key = `${String(n.params.sessionId)}:${String(event?.data.callId)}`
    if (event?.type === 'tool/call') callArgs.set(key, JSON.parse(String(event.data.arguments)) as { version: string })
    if (event?.type !== 'approval/asked') return
    const callId = String(event.data.callId)
    const args = callArgs.get(key)
    assert.ok(args !== undefined, `approval/asked 之前没见到 ${callId} 的参数`)
    const answer = reviewer(args)
    log(`  approval/asked ${callId} | 参数 ${JSON.stringify(args)} → ${answer ?? '不回答'}`)
    if (answer === undefined) return
    // 先写临时文件再改名，应答者轮询时不会读到写了一半的空文件。
    const file = join(dir, `${String(n.params.sessionId)}.${callId}.answer`)
    writeFileSync(`${file}.tmp`, answer)
    renameSync(`${file}.tmp`, file)
  }
  const outcomes: string[] = []
  for (const version of ['2.4', '2.3', '2.5']) {
    const started = Date.now()
    const run = await sdk.run(`部署 payment-api ${version}`, { sessionId: 'duty-2', onNotification })
    const outcome = String(approvalsOf(run)[1]?.data.outcome)
    outcomes.push(outcome)
    log(`部署 ${version}：${outcome} | ${run.finalResponse}`)
    if (version === '2.5') assert.ok(Date.now() - started >= 1000)
  }
  assert.deepEqual(outcomes, ['allowed-once', 'rejected', 'unavailable'])
  log(`部署账本：${ledger().join(' ')}`)
  assert.deepEqual(ledger(), ['{"service":"payment-api","version":"2.4"}'])
  // 应答者读完就删，目录里不留下能被下一次同名调用读到的旧答案。
  assert.deepEqual(readdirSync(dir), [])
  rmSync(dir, { recursive: true, force: true })
}

log('\n== 6. 应答者的超时：不设超时整轮挂住，超时后才到的答案留给下一次 ==')
{
  const dir = temp('dsh-duty-approvals-')
  {
    // 超时设成 10 分钟，相当于不设；3 秒内既不回答也不取消。
    await using sdk = harness({ bridge: dir, timeoutMs: 600_000 })
    const seen: string[] = []
    const pending = sdk.run('部署 payment-api 2.6', {
      sessionId: 'duty-3',
      onNotification(n) {
        const event = eventOf(n)
        if (event !== undefined && ['approval/asked', 'approval/decided', 'turn/end'].includes(event.type)) seen.push(event.type)
      },
    }).then(() => 'returned', (e: unknown) => `threw ${String(e)}`)
    const state = await Promise.race([pending, sleep(3000).then(() => 'still pending')])
    log(`不设超时，没人回答：3 秒后 run() ${state}，已收到的事件 ${seen.join(', ')}`)
    assert.equal(state, 'still pending')
    assert.deepEqual(seen, ['approval/asked'])
  }
  {
    await using sdk = harness({ bridge: dir })
    const run = await sdk.run('部署 payment-api 2.6', { sessionId: 'duty-4' })
    const outcome = String(approvalsOf(run)[1]?.data.outcome)
    log(`超时 1 秒，没人回答：${outcome}`)
    assert.equal(outcome, 'unavailable')
  }
  // 超时之后客户端才写答案，没有人再读它。
  writeFileSync(join(dir, 'duty-4.call-1.answer'), 'allow')
  log(`超时后才写的答案留在目录里：${readdirSync(dir).join(', ')}`)
  const replay = headless(['--session-id', 'duty-4', '部署 payment-api 2.6'], work, ['bridge.cordis.patch.yml'], { DUTY_APPROVAL_DIR: dir, DUTY_APPROVAL_TIMEOUT_MS: '1000' })
  show('新 headless 进程接上 duty-4 再部署 2.6（没人被问）', replay)
  log(`部署账本：${ledger().join(' ')}`)
  assert.equal(replay.stdout, '已完成：payment-api 2.6 已部署\n')
  assert.deepEqual(ledger(), ['{"service":"payment-api","version":"2.4"}', '{"service":"payment-api","version":"2.6"}'])
  assert.deepEqual(readdirSync(dir), [])
  rmSync(dir, { recursive: true, force: true })
}

log('\n== 7. ACP profile：审批转成 session/request_permission ==')
{
  const child = spawn(process.execPath, [
    '--import', tsx, bin, '--profile', 'acp',
    ...['duty.cordis.patch.yml', 'acp.cordis.patch.yml'].flatMap(file => ['--patch', patch(file)]),
  ], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  // 换行分隔的 JSON-RPC：客户端的请求按 id 等结果，服务器发来的 request_permission 交给 onPermission。
  let nextId = 0
  const waiting = new Map<number, (message: Record<string, unknown>) => void>()
  let onPermission: (id: number, params: Record<string, unknown>) => void = () => undefined
  const send = (message: object) => { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) }
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as Record<string, unknown>
    if (message.method === 'session/request_permission') onPermission(message.id as number, message.params as Record<string, unknown>)
    else if (typeof message.id === 'number' && waiting.has(message.id)) waiting.get(message.id)?.(message)
  })
  const request = (method: string, params: object) => new Promise<Record<string, unknown>>((done) => {
    const id = ++nextId
    waiting.set(id, done)
    send({ id, method, params })
  })
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const created = await request('session/new', { cwd: work, mcpServers: [] })
  const acpSession = String((created.result as { sessionId: string }).sessionId)
  const prompt = (text: string) => request('session/prompt', { sessionId: acpSession, prompt: [{ type: 'text', text }] })
  const stop = (reply: Record<string, unknown>) => String((reply.result as { stopReason?: string } | undefined)?.stopReason)

  // 2.4 过 1.5 秒才批准，2.3 拒绝，2.5 不回答、改由客户端取消这一轮。
  const asks: string[] = []
  onPermission = (id, params) => {
    const options = (params.options as { optionId: string }[]).map(o => o.optionId)
    const callId = (params.toolCall as { toolCallId: string }).toolCallId
    asks.push(callId)
    if (asks.length === 1) log(`  session/request_permission | toolCallId ${callId}，选项 ${options.join(' / ')}`)
    const reply = (optionId: string) => { send({ id, result: { outcome: { outcome: 'selected', optionId } } }) }
    if (asks.length === 1) setTimeout(() => { reply('allow-once') }, 1500)
    else if (asks.length === 2) reply('reject-once')
    else send({ method: 'session/cancel', params: { sessionId: acpSession } })
  }
  const allowed = await prompt('部署 payment-api 2.4')
  log(`部署 2.4，1.5 秒后选 allow-once → stopReason ${stop(allowed)}`)
  const rejected = await prompt('部署 payment-api 2.3')
  log(`部署 2.3，选 reject-once → stopReason ${stop(rejected)}`)
  const cancelled = await prompt('部署 payment-api 2.5')
  log(`部署 2.5，不回答、发 session/cancel → stopReason ${stop(cancelled)}`)
  child.stdin.end()
  const [code] = await new Promise<[number | null]>((done) => { child.once('exit', c => { done([c]) }) })
  const decided = sessionLog(acpSession).filter(e => e.type === 'approval/decided').map(e => String(e.data.outcome))
  log(`关闭 stdin 后子进程退出码 ${String(code)}，会话日志里的 approval/decided：${decided.join(', ')}`)
  log(`部署账本：${ledger().join(' ')}`)
  assert.equal(code, 0, stderr)
  assert.deepEqual(asks.length, 3)
  assert.equal(stop(allowed), 'end_turn')
  assert.deepEqual(decided, ['allowed-once', 'rejected', 'cancelled'])
  assert.deepEqual(ledger(), ['{"service":"payment-api","version":"2.4"}', '{"service":"payment-api","version":"2.6"}', '{"service":"payment-api","version":"2.4"}'])
}
