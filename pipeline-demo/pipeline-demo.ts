/** One lookup_release call through every ctx.tools pipeline stage, then the ways a stage can deny, wrap, or rewrite it. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type PreToolDecision, type PostToolDecision } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as timeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'

const log = (msg: string) => { console.log(msg) }
const root = new Context()
await root.plugin(SystemPrompt)
await root.plugin(ToolRuntime)

let seq = 0
const call = (args: unknown) => root.tools.execute({
  callId: ToolCallId(`demo-${++seq}`), name: 'lookup_release', arguments: args, signal: new AbortController().signal,
})
type Result = Awaited<ReturnType<typeof call>>
const textOf = (r: Result) => (r.content[0] as { text: string }).text
const brief = (r: Result) => r.isError
  ? `isError code=${r.error.info?.code ?? '-'} text=${JSON.stringify(textOf(r))}`
  : `ok content=${JSON.stringify(textOf(r))}`

const records = [
  { id: 'demo-001', service: 'payment-api', version: '1.4.1', status: 'succeeded' },
  { id: 'demo-003', service: 'payment-api', version: '1.4.2', status: 'failed' },
  { id: 'demo-007', service: 'order-api', version: '2.0.0', status: 'succeeded' },
]
let bodyDelayMs = 0
let ignoreSignal = false
const trace: string[] = []
root.tools.register(defineTool({
  name: 'lookup_release',
  description: 'Query synthetic release history. Omit service to list every service.',
  timeoutMs: 50,
  parameters: { service: { type: 'string' } },
  output: {
    schema: {
      type: 'object', additionalProperties: false,
      properties: { count: { type: 'integer', required: true }, ids: { type: 'array', items: { type: 'string' }, required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: `${value.count} record(s): ${value.ids.join(',')}` }],
  },
  finalizeContent: () => { trace.push('finalizeContent'); return undefined },
  async execute(args, exec) {
    trace.push('body')
    if (bodyDelayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, bodyDelayMs)
        if (!ignoreSignal) {
          exec.signal.addEventListener('abort', () => {
            clearTimeout(t)
            const reason: unknown = exec.signal.reason
            reject(reason instanceof Error ? reason : new Error('aborted', { cause: reason }))
          }, { once: true })
        }
      })
    }
    const hits = records.filter(r => args.service === undefined || r.service === args.service)
    return { count: hits.length, ids: hits.map(r => r.id) }
  },
}))

// Pure tracers: each stage records itself and delegates.
root.on('tools/pre-execute', (_exec, next) => { trace.push('pre-execute'); return next() })
root.tools.guard(() => { trace.push('guard'); return undefined })
root.on('tools/execute', async (_exec, next) => { trace.push('execute>'); const r = await next(); trace.push('<execute'); return r })
root.on('tools/post-execute', (_exec, _result, next) => { trace.push('post-execute'); return next() })
root.on('tools/result', () => { trace.push('result') })
const run = async (label: string, args: unknown) => {
  trace.length = 0
  const r = await call(args)
  log(`  ${label}: ${brief(r)}`)
  log(`    stages: ${trace.join(' -> ')}`)
  return { r, stages: trace.join(' -> ') }
}
const FULL = 'pre-execute -> guard -> execute> -> body -> <execute -> post-execute -> finalizeContent -> result'
const DENIED_IN_PRE = 'pre-execute -> post-execute -> finalizeContent -> result'
const FULL_SCAN_DENIED = 'lookup_release requires an explicit service name'

log('1. one call, every stage')
let out = await run('service=payment-api', { service: 'payment-api' })
assert.equal(out.r.isError, false)
assert.equal(out.stages, FULL)

log('2. a full-scan policy written as a pre-execute listener')
const denyFullScan = (args: unknown) => {
  const service = (args as { service?: unknown } | undefined)?.service
  return typeof service === 'string' && service.trim() ? undefined : 'lookup_release requires an explicit service name'
}
const policy = root.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
  const reason = exec.name === 'lookup_release' ? denyFullScan(exec.arguments) : undefined
  return reason ? Promise.resolve({ kind: 'deny', reason }) : next()
})
out = await run('no service', {})
assert.equal(out.r.error?.message, FULL_SCAN_DENIED)
assert.equal(out.stages, DENIED_IN_PRE)
let yesMan = root.on('tools/pre-execute', () => Promise.resolve<PreToolDecision>({ kind: 'allow' }))
out = await run('no service + allow-all appended', {})
assert.equal(out.r.error?.message, FULL_SCAN_DENIED)
yesMan()
// prepend=true 把监听器放到最外层，它不调 next()，里层的策略就不会执行。
yesMan = root.on('tools/pre-execute', () => { trace.push('allow-all'); return Promise.resolve<PreToolDecision>({ kind: 'allow' }) }, true)
out = await run('no service + allow-all prepended', {})
assert.equal(out.r.isError, false, 'a prepended allow-all bypasses a pre-execute policy')
assert.equal(textOf(out.r), '3 record(s): demo-001,demo-003,demo-007')
policy(); yesMan()

log('3. the same policy as a monotonic guard')
const guard = root.tools.guard(exec => exec.name === 'lookup_release' ? denyFullScan(exec.arguments) : undefined)
const yesMan2 = root.on('tools/pre-execute', () => { trace.push('allow-all'); return Promise.resolve<PreToolDecision>({ kind: 'allow' }) }, true)
for (const [label, args] of [
  ['no service + allow-all prepended', {}],
  ['service=123 (never schema-checked yet)', { service: 123 }],
  ['service="   "', { service: '   ' }],
] as const) {
  out = await run(label, args)
  assert.equal(out.r.error?.message, FULL_SCAN_DENIED)
  assert.equal(out.stages, 'allow-all -> guard -> post-execute -> finalizeContent -> result')
}
yesMan2()

log('4. ask with no approval service mounted')
// pre-execute 拿到的参数未经 schema 校验，先判断类型再读。
const asker = root.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> =>
  (exec.arguments as { service?: unknown } | null | undefined)?.service === 'payment-api' ? Promise.resolve({ kind: 'ask', reason: 'production payment data' }) : next())
out = await run('service=payment-api', { service: 'payment-api' })
assert.equal(out.r.error?.message, 'production payment data')
assert.equal(out.stages, DENIED_IN_PRE)
asker()

log('5. around: timeout-policy wraps tools/execute')
await root.plugin(timeoutPolicy)
bodyDelayMs = 200
let t0 = Date.now()
out = await run('body takes 200ms, timeoutMs=50', { service: 'order-api' })
const cooperative = Date.now() - t0
log(`    elapsed ~${Math.round(cooperative / 10) * 10}ms`)
assert.equal(out.r.error?.info?.code, 'TOOL_TIMEOUT')
assert.equal(out.stages, FULL)
assert.ok(cooperative < 150, `a body that honors exec.signal should stop near 50ms, took ${cooperative}ms`)
ignoreSignal = true
t0 = Date.now()
out = await run('same, but the body ignores exec.signal', { service: 'order-api' })
const stubborn = Date.now() - t0
log(`    elapsed ~${Math.round(stubborn / 10) * 10}ms`)
assert.equal(out.r.error?.info?.code, 'TOOL_TIMEOUT')
assert.ok(stubborn >= 195, `the registry waits for a body that ignores exec.signal, took ${stubborn}ms`)
bodyDelayMs = 0
ignoreSignal = false

log('6. post-execute: replaced values are validated again')
const redact = root.on('tools/post-execute', async (_exec, result, next): Promise<PostToolDecision> => {
  const d = await next()
  if (result.isError || d.kind !== 'accept') return d
  return { kind: 'accept', value: { count: (result.value as { count: number }).count, ids: [] } }
})
out = await run('redact ids', { service: 'payment-api' })
assert.equal(textOf(out.r), '2 record(s): ')
redact()
const broken = root.on('tools/post-execute', (): Promise<PostToolDecision> =>
  Promise.resolve({ kind: 'accept', value: { count: 'two', ids: [] } }))
out = await run('replace with an off-schema value', { service: 'payment-api' })
assert.equal(out.r.error?.info?.code, 'INVALID_TOOL_OUTPUT')
broken()
const blocker = root.on('tools/post-execute', (): Promise<PostToolDecision> =>
  Promise.resolve({ kind: 'block', feedback: [{ type: 'text', text: 'release data is frozen during the incident' }] }))
out = await run('block after the body ran', { service: 'payment-api' })
assert.equal(out.r.isError, true)
assert.equal(textOf(out.r), 'release data is frozen during the incident')
assert.equal(out.stages, FULL)
blocker()

log('7. a throwing listener fails the call, it does not skip the policy')
const buggy = root.on('tools/pre-execute', () => { throw new Error('policy service unreachable') })
out = await run('pre-execute throws', { service: 'payment-api' })
assert.equal(out.r.error?.message, 'policy service unreachable')
assert.equal(out.stages, 'pre-execute -> finalizeContent -> result')
buggy(); guard()

process.exit(0)
