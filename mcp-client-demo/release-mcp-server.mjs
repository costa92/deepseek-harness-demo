/** A hand-written MCP stdio server for the synthetic release platform: newline-delimited JSON-RPC, no SDK. */
import { appendFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

// 账本：服务器每次启动、每个请求、每次部署都记一行，demo 从这里核对平台上实际发生了什么。
const [ledger] = process.argv.slice(2)
const record = (event, extra = {}) => appendFileSync(ledger, `${JSON.stringify({ event, ...extra })}\n`)
record('start', {
  token: process.env.RELEASE_API_TOKEN === undefined ? 'absent' : 'present',
  dsh: process.env.DSH_DEMO_MARKER === undefined ? 'absent' : 'present',
})
// 有 .down 标记时启动即退出，模拟平台起不来。
if (existsSync(`${ledger}.down`)) process.exit(1)
process.stdin.once('end', () => process.exit(0))

const deployTool = {
  name: 'deploy_release',
  description: 'Deploy one version of a service to the synthetic release platform.',
  inputSchema: {
    type: 'object',
    properties: { service: { type: 'string' }, version: { type: 'string' } },
    required: ['service', 'version'],
  },
  outputSchema: {
    type: 'object',
    properties: { service: { type: 'string' }, version: { type: 'string' }, outcome: { type: 'string' } },
    required: ['service', 'version', 'outcome'],
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
}

// 可选行为由配置的 env 打开：RELEASE_ODD_NAMES 多声明两个名字不合规的工具；
// RELEASE_LIST_CHANGE 在第一次部署后多出一个 rollback_release 工具并发通知。
const tools = [deployTool]
if (process.env.RELEASE_ODD_NAMES !== undefined) {
  tools.push({ ...deployTool, name: 'deploy.release' }, { ...deployTool, name: `deploy_${'x'.repeat(60)}` })
}
const listChange = process.env.RELEASE_LIST_CHANGE !== undefined
const rollbackTool = { ...deployTool, name: 'rollback_release', description: 'Roll back one service.' }

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  record(request.method)
  switch (request.method) {
    case 'initialize':
      return send({ id: request.id, result: {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: listChange ? { listChanged: true } : {} },
        serverInfo: { name: 'release-platform', version: '1.0.0' },
        instructions: 'Always look up the latest release before deploying.',
      } })
    case 'tools/list':
      return send({ id: request.id, result: { tools } })
    case 'tools/call': {
      const args = request.params.arguments ?? {}
      // 平台自己不校验类型，版本号一律转成字符串。2.3 每次失败；2.6 部署完成后、回复之前进程崩溃。
      const service = String(args.service)
      const version = String(args.version)
      const outcome = version === '2.3' ? 'failed' : 'succeeded'
      record('deploy', { service, version, outcome })
      if (version === '2.6') process.exit(1)
      const reply = () => {
        record('reply', { version })
        send({ id: request.id, result: {
          content: [{ type: 'text', text: `${service} ${version} ${outcome}` }],
          structuredContent: { service, version, outcome },
        } })
        if (listChange && !tools.includes(rollbackTool)) {
          tools.push(rollbackTool)
          send({ method: 'notifications/tools/list_changed' })
        }
      }
      // 2.8 慢一点：300 毫秒后才回复。
      if (version === '2.8') return void setTimeout(reply, 300)
      return reply()
    }
    case 'ping':
      return send({ id: request.id, result: {} })
    default:
      return send({ id: request.id, error: { code: -32601, message: `unsupported method ${request.method}` } })
  }
})
