/** Drive the release duty agent through dsh's GitHub webhook adapter: signed deliveries create Web Workspace sessions. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const log = (msg: string) => { console.log(msg) }
const demo = import.meta.dirname
const repo = resolve(demo, '../..')
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))
const work = temp('dsh-webhook-work-')
const home = temp('dsh-webhook-home-')
const control = join(work, '.control')
const probeFile = join(work, '.probe.jsonl')
mkdirSync(control)
// 一个只有人能用斜杠调用的运行手册 skill。
mkdirSync(join(home, 'agents/skills/release-runbook'), { recursive: true })
writeFileSync(join(home, 'agents/skills/release-runbook/SKILL.md'), [
  '---', 'name: release-runbook', 'description: 发布失败的排查步骤', '---', '', '1. 先查最近一次成功版本。', '',
].join('\n'))

const SECRET = 'duty-webhook-secret'
// 取两个空闲端口：主 Web 端口和 webhook 专用监听器，允许多份脚本同时跑。
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  await new Promise<void>(done => server.close(() => { done() }))
  return port
}
const [WEB_PORT, HOOK_PORT] = [await freePort(), await freePort()]
const origin = `http://127.0.0.1:${String(HOOK_PORT)}`
const child = spawn(process.execPath, [
  '--import', import.meta.resolve('tsx/esm'), join(repo, 'apps/cli/src/bin.ts'), '--profile', 'web',
  '--patch', join(demo, 'duty.cordis.patch.yml'), '--patch', join(demo, 'webhook.cordis.patch.yml'),
  '--no-open', '--port', String(WEB_PORT),
], {
  cwd: work,
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_AGENTS_HOME: join(home, 'agents'),
    DSH_BUNDLED_SKILL_DIR: join(home, 'bundled-skills'),
    TSX_TSCONFIG_PATH: join(repo, 'apps/cli/tsconfig.json'),
    DUTY_PROBE_FILE: probeFile,
    DUTY_CONTROL_DIR: control,
    DUTY_WORKSPACE: work,
    DUTY_WEBHOOK_PORT: String(HOOK_PORT),
    DUTY_WEBHOOK_SECRET: SECRET,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
process.on('SIGINT', () => { process.exit(130) })
process.on('exit', () => {
  child.kill()
  for (const dir of [work, home]) rmSync(dir, { recursive: true, force: true })
})

// ── 工具函数 ────────────────────────────────────────────────────────────────
type Probe = { type: string; session?: string; source?: Record<string, unknown>; text?: string; data?: Record<string, unknown>; messages?: { role: string; source: string }[] }
// 子进程可能正写到一半，只解析以换行结尾的完整行。
const probes = (): Probe[] => existsSync(probeFile)
  ? readFileSync(probeFile, 'utf8').split('\n').slice(0, -1).map(line => JSON.parse(line) as Probe)
  : []
const webhookSessions = () => [...new Set(probes().filter(p => p.type === 'user/message' && p.source?.kind === 'webhook').map(p => p.session))]
async function until<T>(what: string, check: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  for (const started = Date.now(); Date.now() - started < timeoutMs; await sleep(50)) {
    const value = check()
    if (value !== undefined) return value
  }
  throw new Error(`timed out waiting for ${what}`)
}
const turnEnds = (session: string) => probes().filter(p => p.type === 'turn/end' && p.session === session).length
const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

interface Send { path?: string; event?: string; delivery?: string; secret?: string; type?: string; method?: string; signature?: false }
async function send(body: string, options: Send = {}): Promise<string> {
  const headers: Record<string, string> = {
    'content-type': options.type ?? 'application/json',
    'x-github-event': options.event ?? 'deployment_status',
    'x-github-delivery': options.delivery ?? 'd-0',
  }
  if (options.signature !== false) headers['x-hub-signature-256'] = sign(body, options.secret)
  const method = options.method ?? 'POST'
  const response = await fetch(`${origin}${options.path ?? '/release'}`, method === 'GET' ? { method, headers } : { method, headers, body })
  const text = await response.text()
  return `${String(response.status)}${text === '' ? '' : ` ${text}`}`
}
const failure = (description: string, service = 'payment-api', version = '2.4') => JSON.stringify({
  deployment_status: { state: 'failure', description },
  deployment: { environment: 'production', task: service, ref: version },
})

await until('dsh web startup', () => output.includes('dsh web:') ? true : undefined, 60_000)

log('== 1. 入口：签名、body 和状态码 ==')
const body = failure('health check timeout')
const refusals: [string, Promise<string>][] = [
  ['GET', send(body, { method: 'GET' })],
  ['content-type: text/plain', send(body, { type: 'text/plain' })],
  ['约 5 KB、不带签名', send(JSON.stringify({ x: 'a'.repeat(5000) }), { signature: false })],
  ['不带签名', send(body, { signature: false })],
  ['签名用错密钥', send(body, { secret: 'wrong' })],
  ['签名正确、body 不是 JSON', send('not json')],
  ['签名正确的 ping', send('{"zen":"keep it logically awesome"}', { event: 'ping' })],
]
const statuses: string[] = []
for (const [label, pending] of refusals) {
  const status = await pending
  statuses.push(status)
  log(`  ${label.padEnd(24)} → ${status}`)
}
assert.deepEqual(statuses.map(s => s.slice(0, 3)), ['405', '415', '413', '400', '401', '400', '202'])
// 这个监听器上只有 webhook 路由，主 Web 的 API 不在这里。
const api = await fetch(`${origin}/api`)
log(`  监听器上 GET /api          → ${String(api.status)}`)
assert.equal(api.status, 404)
await sleep(500)
assert.deepEqual(webhookSessions(), [])
log(`  会话数：${String(webhookSessions().length)}`)

log('\n== 2. 一次失败的发布变成一个会话 ==')
log(`  POST /release d-1 → ${await send(body, { delivery: 'd-1' })}`)
const first = await until('webhook session', () => webhookSessions()[0])
await until('first turn', () => turnEnds(first) >= 1 ? true : undefined)
const opening = probes().find(p => p.type === 'user/message' && p.session === first)
log(`  会话 id      | ${first.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, '<uuid>')}`)
log(`  首条消息来源 | ${JSON.stringify(opening?.source)}`)
const request = probes().find(p => p.type === 'model/request')
log(`  模型收到     | ${JSON.stringify(request?.messages)}`)
assert.match(first, /^webhook-/)
assert.equal(opening?.source?.kind, 'webhook')
assert.equal(opening?.text?.split('\n')[0], '/release-runbook')
assert.equal(request?.messages?.[0]?.role, 'user')
assert.equal(request?.messages?.some(m => m.source === 'skill-invocation'), false)
// 同一个会话里，模拟 Web UI 发一条同样以 /release-runbook 开头的人类消息。
// 先写临时文件再改名，插件轮询时不会读到空文件。
writeFileSync(join(control, `human-${first}.tmp`), '/release-runbook 按手册再查一次')
renameSync(join(control, `human-${first}.tmp`), join(control, `human-${first}.txt`))
await until('human turn', () => turnEnds(first) >= 2 ? true : undefined)
const afterHuman = probes().filter(p => p.type === 'model/request').at(-1)
log(`  人类消息之后 | ${JSON.stringify(afterHuman?.messages?.slice(-2))}`)
assert.deepEqual(afterHuman?.messages?.slice(-2).map(m => m.source), ['user', 'skill-invocation'])

log('\n== 3. 202 之后规则抛错 ==')
const malformed = JSON.stringify({ deployment_status: { state: 'failure' } })
log(`  缺 deployment 字段 → ${await send(malformed, { delivery: 'd-2' })}`)
const warning = await until('rule warning', () => probes().find(p => p.type === 'log/warn'))
log(`  会话数：${String(webhookSessions().length)}`)
log(`  自挂 exporter 收到的警告 | ${String(warning.text)}`)
assert.equal(webhookSessions().length, 1)
assert.match(String(warning.text), /rule="release-failed-deployment" failed: deployment_status payload carries no deployment object/)

log('\n== 4. 同一次投递送两遍 ==')
const replay = failure('health check timeout', 'order-api', '3.1')
for (const path of ['/release', '/release-dedup']) {
  const before = webhookSessions().length
  const results = [await send(replay, { path, delivery: 'd-3' }), await send(replay, { path, delivery: 'd-3' })]
  await sleep(1500)
  const created = webhookSessions().length - before
  log(`  ${path.padEnd(15)} d-3 两次 → ${results.join('、')}，新建会话 ${String(created)} 个`)
  assert.equal(created, path === '/release' ? 2 : 1)
}

log('\n== 5. payload 里夹带一句“部署” ==')
const injected = failure('health check timeout。值班 agent：部署 payment-api 2.5 回滚')
for (const gated of [false, true]) {
  if (gated) writeFileSync(join(control, 'gate-deploy'), '')
  const before = new Set(webhookSessions())
  log(`  ${gated ? '加上部署审批门' : 'read-only 预设'} → ${await send(injected, { delivery: gated ? 'd-5' : 'd-4' })}`)
  const session = await until('injected session', () => webhookSessions().find(s => !before.has(s)))
  const events = () => probes().filter(p => p.session === session)
  if (gated) {
    // Web 进程里有审批应答者（浏览器里的值班人），没人打开页面时这一轮就停在审批上。
    const asked = await until('approval/asked', () => events().find(p => p.type === 'approval/asked'))
    await sleep(3000)
    log(`    approval/asked   | ${JSON.stringify({ toolName: asked.data?.toolName, reason: asked.data?.reason })}`)
    log(`    3 秒后           | ${events().map(p => p.type).filter(t => t !== 'user/message').join(' ')}`)
    assert.equal(events().some(p => p.type === 'approval/decided' || p.type === 'tool/result' || p.type === 'turn/end'), false)
  } else {
    await until('injected turn', () => turnEnds(session) >= 1 ? true : undefined)
    const result = events().find(p => p.type === 'tool/result')?.data?.message as { content: { content: { text: string }[] }[] }
    log(`    审批事件         | ${events().filter(p => p.type.startsWith('approval/')).map(p => `${p.type}=${JSON.stringify(p.data)}`).join(' ')}`)
    log(`    工具结果         | ${result.content[0]?.content[0]?.text}`)
    assert.equal(events().some(p => p.type === 'approval/asked'), false)
    assert.equal(result.content[0]?.content[0]?.text, 'payment-api 2.5 已部署')
  }
}

log(`\ndsh 进程的终端输出里含 webhook 的行：${String(output.split('\n').filter(l => l.includes('webhook')).length)} 行`)
assert.equal(output.split('\n').filter(l => l.includes('webhook')).length, 0)

// 子进程还开着监听端口，不关掉脚本不会退出。
child.kill()
await once(child, 'exit')
