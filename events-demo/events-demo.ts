/** Five dispatch modes on one release-query path. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'

interface Query { service: string; operator: string }
interface Record { id: string; version: string; token: string }

declare module '@deepseek-ai/cordis' {
  interface Events {
    'release/query'(query: Query, next: () => Record[]): Record[]
    'release/freeze'(query: Query): string | false | void
    'release/queried'(query: Query, count: number): void
    'release/audit'(query: Query): Promise<void>
    'release/notify'(query: Query): Promise<string | void>
    'check/serial'(): Promise<unknown>
    'check/bail'(): unknown
    'check/waterfall'(next: () => string): string | undefined
    'check/value'(): unknown
    'check/async'(): Promise<void>
  }
}

const lines: string[] = []
const log = (msg: string) => { lines.push(msg); console.log(msg) }
const DB: Record[] = [{ id: 'demo-001', version: '1.4.0', token: 'tok_live_9f3a' }]
const query: Query = { service: 'payment-api', operator: 'costa' }

const root = new Context()

log('1. waterfall: onion order, redaction happens on the way out')
// 先注册的在外层：进入时从上到下，返回时从下到上。
const redact = root.plugin({ name: 'redact', apply(ctx: Context) {
  ctx.on('release/query', (_q, next) => {
    log('  redact: enter')
    const records = next()
    log('  redact: exit, rewriting token')
    return records.map(r => ({ ...r, token: 'REDACTED' }))
  })
} })
const trace = root.plugin({ name: 'trace', apply(ctx: Context) {
  ctx.on('release/query', (_q, next) => {
    log('  trace: enter')
    const records = next()
    log(`  trace: exit, ${records.length} record(s)`)
    return records
  })
} })
await redact
await trace
const inner = () => { log('  inner: read DB'); return DB }
const from = lines.length
let result = root.waterfall('release/query', query, inner)
assert.deepEqual(lines.slice(from).map(l => l.trim().split(':')[0]), ['redact', 'trace', 'inner', 'trace', 'redact'])
log(`  result=${JSON.stringify(result)}`)
assert.equal(result[0]?.token, 'REDACTED')

log('2. waterfall: a middleware that never calls next() vetoes the rest')
const veto = root.plugin({ name: 'veto', apply(ctx: Context) {
  ctx.on('release/query', () => { log('  veto: refuse, not calling next()'); return [] }, true)
} })
await veto
result = root.waterfall('release/query', query, inner)
log(`  result=${JSON.stringify(result)}`)
assert.deepEqual(result, [])
await veto.dispose()

log('3. bail: isBailed treats only null/false/undefined as "not handled"')
const freeze = root.plugin({ name: 'freeze', apply(ctx: Context) {
  ctx.on('release/freeze', () => { log('  window-check: not frozen -> return false'); return false })
  ctx.on('release/freeze', q => { log('  policy-check: frozen -> return reason'); return `frozen for ${q.service}` })
  ctx.on('release/freeze', () => { log('  never reached'); return 'late' })
} })
await freeze
const reason = root.bail('release/freeze', query)
log(`  bail result=${JSON.stringify(reason)}`)
assert.equal(reason, 'frozen for payment-api')

log('4. emit: return values dropped, synchronous, one throw stops the rest')
const listeners = root.plugin({ name: 'listeners', apply(ctx: Context) {
  ctx.on('release/queried', () => { log('  audit-log wrote a line'); return 'ignored' })
  ctx.on('release/queried', () => { throw new Error('metrics down') })
  ctx.on('release/queried', () => { log('  never reached') })
} })
await listeners
assert.throws(() => { root.emit('release/queried', query, 1) }, (e: Error) => {
  log(`  caught: ${e.message}`)
  return e.message === 'metrics down'
})

log('5. parallel: all listeners run, failures come back aggregated')
const par = root.plugin({ name: 'par', apply(ctx: Context) {
  ctx.on('release/audit', async () => { log('  audit A ok'); })
  ctx.on('release/audit', async () => { throw new Error('audit B failed') })
  ctx.on('release/audit', async () => { throw new Error('audit C failed') })
} })
await par
await assert.rejects(root.parallel('release/audit', query), (e: AggregateError) => {
  const messages = (e.errors as Error[]).map(x => x.message)
  log(`  ${e.constructor.name} with ${messages.length}: ${messages.join(', ')}`)
  return e instanceof AggregateError && messages.length === 2
})

log('6. serial: awaits each listener, stops at the first bail value')
const ser = root.plugin({ name: 'ser', apply(ctx: Context) {
  ctx.on('release/notify', async () => { log('  notify slack -> undefined'); })
  ctx.on('release/notify', async () => { log('  notify oncall -> "sent"'); return 'sent' })
  ctx.on('release/notify', async () => { log('  never reached'); return 'x' })
} })
await ser
const notified = await root.serial('release/notify', query)
log(`  serial result=${JSON.stringify(notified)}`)
assert.equal(notified, 'sent')

log('7. listeners are effects: dispose the plugin, the middleware is gone')
await redact.dispose()
result = root.waterfall('release/query', query, inner)
log(`  result=${JSON.stringify(result)}`)
assert.equal(result[0]?.token, 'tok_live_9f3a')
assert.ok(!lines.includes('  never reached'))

log('8. serial / bail / waterfall when a listener throws')
const skipped: string[] = []
const throwers = root.plugin({ name: 'throwers', apply(ctx: Context) {
  ctx.on('check/serial', async () => { throw new Error('serial boom') })
  ctx.on('check/serial', async () => { skipped.push('serial') })
  ctx.on('check/bail', () => { throw new Error('bail boom') })
  ctx.on('check/bail', () => { skipped.push('bail') })
  ctx.on('check/waterfall', () => { throw new Error('waterfall boom') })
  ctx.on('check/waterfall', (next) => { skipped.push('waterfall'); return next() })
} })
await throwers
await assert.rejects(root.serial('check/serial'), (e: Error) => { log(`  serial rejected: ${e.message}`); return e.message === 'serial boom' })
assert.throws(() => root.bail('check/bail'), (e: Error) => { log(`  bail threw: ${e.message}`); return e.message === 'bail boom' })
assert.throws(() => root.waterfall('check/waterfall', () => { skipped.push('inner'); return 'inner' }), (e: Error) => {
  log(`  waterfall threw: ${e.message}`)
  return e.message === 'waterfall boom'
})
log(`  later listeners / inner ran: [${skipped}]`)
assert.deepEqual(skipped, [])
await throwers.dispose()

log('9. nobody bails, a middleware returns undefined')
const quiet = root.plugin({ name: 'quiet', apply(ctx: Context) {
  ctx.on('check/serial', async () => undefined)
  ctx.on('check/bail', () => null)
  ctx.on('check/waterfall', (next) => { next() })
} })
await quiet
const serialNone = await root.serial('check/serial')
const bailNone = root.bail('check/bail')
const waterfallNone = root.waterfall('check/waterfall', () => 'inner value')
log(`  serial=${serialNone}, bail=${bailNone}, waterfall=${waterfallNone} (inner returned "inner value")`)
assert.equal(serialNone, undefined)
assert.equal(bailNone, undefined)
assert.equal(waterfallNone, undefined)
await quiet.dispose()

log('10. isBailed on edge values')
const verdicts: string[] = []
for (const value of [null, false, undefined, 0, '', NaN]) {
  let second = false
  const probe = root.plugin({ name: 'probe', apply(ctx: Context) {
    ctx.on('check/value', () => value)
    ctx.on('check/value', () => { second = true; return 'next' })
  } })
  await probe
  const out = root.bail('check/value')
  const label = typeof value === 'string' ? "''" : String(value)
  verdicts.push(`${label}->${second ? 'continue' : 'stop'}`)
  log(`  ${label.padEnd(9)} -> ${second ? 'continue, result=' + JSON.stringify(out) : 'stop, result=' + (typeof out === 'string' ? JSON.stringify(out) : String(out))}`)
  await probe.dispose()
}
assert.deepEqual(verdicts, ['null->continue', 'false->continue', 'undefined->continue', '0->stop', "''->stop", 'NaN->stop'])

log('11. emit with an async listener that rejects')
const unhandled: string[] = []
const onUnhandled = (reason: unknown) => { unhandled.push((reason as Error).message) }
process.on('unhandledRejection', onUnhandled)
const asyncFail = root.plugin({ name: 'async-fail', apply(ctx: Context) {
  ctx.on('check/async', async () => { throw new Error('async listener failed') })
} })
await asyncFail
root.emit('check/async')
log('  emit returned without throwing')
await new Promise(r => setTimeout(r, 10))
process.off('unhandledRejection', onUnhandled)
log(`  unhandledRejection: ${unhandled.join(', ')}`)
assert.deepEqual(unhandled, ['async listener failed'])
await asyncFail.dispose()

log('12. dispose root')
await root.fiber.dispose()
