/** A hand-written MCP stdio server for the synthetic release platform: newline-delimited JSON-RPC, no SDK. */
import { appendFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

// 账本：服务器每次启动、每个请求、每次部署都记一行，demo 从这里核对平台上实际发生了什么。
const [ledger] = process.argv.slice(2)
const record = (event, extra = {}) => appendFileSync(ledger, `${JSON.stringify({ event, ...extra })}\n`)
record('start', { token: process.env.RELEASE_API_TOKEN === undefined ? 'absent' : 'present' })
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

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  record(request.method)
  switch (request.method) {
    case 'initialize':
      return send({ id: request.id, result: {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'release-platform', version: '1.0.0' },
        instructions: 'Always look up the latest release before deploying.',
      } })
    case 'tools/list':
      return send({ id: request.id, result: { tools: [deployTool] } })
    case 'tools/call': {
      const args = request.params.arguments ?? {}
      // 平台自己不校验类型，版本号一律转成字符串。2.3 每次失败；2.6 部署完成后、回复之前进程崩溃。
      const service = String(args.service)
      const version = String(args.version)
      const outcome = version === '2.3' ? 'failed' : 'succeeded'
      record('deploy', { service, version, outcome })
      if (version === '2.6') process.exit(1)
      return send({ id: request.id, result: {
        content: [{ type: 'text', text: `${service} ${version} ${outcome}` }],
        structuredContent: { service, version, outcome },
      } })
    }
    case 'ping':
      return send({ id: request.id, result: {} })
    default:
      return send({ id: request.id, error: { code: -32601, message: `unsupported method ${request.method}` } })
  }
})
