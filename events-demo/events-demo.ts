/** Five dispatch modes on one release-query path. */
import { Context } from '@deepseek-ai/cordis'

interface Query { service: string; operator: string }
interface Record { id: string; version: string; token: string }

declare module '@deepseek-ai/cordis' {
  interface Events {
    'release/query'(query: Query, next: () => Record[]): Record[]
    'release/freeze'(query: Query): string | void
    'release/queried'(query: Query, count: number): void
    'release/audit'(query: Query): Promise<void>
    'release/notify'(query: Query): Promise<string | void>
  }
}

const log = (msg: string) => console.log(msg)
const DB: Record[] = [{ id: 'demo-001', version: '1.4.0', token: 'tok_live_9f3a' }]
const query: Query = { service: 'payment-api', operator: 'costa' }

const root = new Context()

log('1. waterfall: onion order, redaction happens on the way out')
// 先注册的在外层：进入时从上到下，返回时从下到上。
const redact = root.plugin({ name: 'redact', apply(ctx: Context) {
  ctx.on('release/query', (q, next) => {
    log('  redact: enter')
    const records = next()
    log('  redact: exit, rewriting token')
    return records.map(r => ({ ...r, token: 'REDACTED' }))
  })
} })
const trace = root.plugin({ name: 'trace', apply(ctx: Context) {
  ctx.on('release/query', (q, next) => {
    log('  trace: enter')
    const records = next()
    log(`  trace: exit, ${records.length} record(s)`)
    return records
  })
} })
await redact
await trace
const inner = () => { log('  inner: read DB'); return DB }
log(`  result=${JSON.stringify(root.waterfall('release/query', query, inner))}`)

log('2. waterfall: a middleware that never calls next() vetoes the rest')
const veto = root.plugin({ name: 'veto', apply(ctx: Context) {
  ctx.on('release/query', () => { log('  veto: refuse, not calling next()'); return [] }, true)
} })
await veto
log(`  result=${JSON.stringify(root.waterfall('release/query', query, inner))}`)
await veto.dispose()

log('3. bail: isBailed treats only null/false/undefined as "not handled"')
const freeze = root.plugin({ name: 'freeze', apply(ctx: Context) {
  ctx.on('release/freeze', () => { log('  window-check: not frozen -> return false'); return false })
  ctx.on('release/freeze', q => { log('  policy-check: frozen -> return reason'); return `frozen for ${q.service}` })
  ctx.on('release/freeze', () => { log('  never reached'); return 'late' })
} })
await freeze
log(`  bail result=${JSON.stringify(root.bail('release/freeze', query))}`)

log('4. emit: return values dropped, synchronous, one throw stops the rest')
const listeners = root.plugin({ name: 'listeners', apply(ctx: Context) {
  ctx.on('release/queried', () => { log('  audit-log wrote a line'); return 'ignored' })
  ctx.on('release/queried', () => { throw new Error('metrics down') })
  ctx.on('release/queried', () => log('  never reached'))
} })
await listeners
try { root.emit('release/queried', query, 1) } catch (e: any) { log(`  caught: ${e.message}`) }

log('5. parallel: all listeners run, failures come back aggregated')
const par = root.plugin({ name: 'par', apply(ctx: Context) {
  ctx.on('release/audit', async () => { log('  audit A ok'); })
  ctx.on('release/audit', async () => { throw new Error('audit B failed') })
  ctx.on('release/audit', async () => { throw new Error('audit C failed') })
} })
await par
try { await root.parallel('release/audit', query) } catch (e: any) {
  log(`  ${e.constructor.name} with ${e.errors.length}: ${e.errors.map((x: Error) => x.message).join(', ')}`)
}

log('6. serial: awaits each listener, stops at the first bail value')
const ser = root.plugin({ name: 'ser', apply(ctx: Context) {
  ctx.on('release/notify', async () => { log('  notify slack -> undefined'); })
  ctx.on('release/notify', async () => { log('  notify oncall -> "sent"'); return 'sent' })
  ctx.on('release/notify', async () => { log('  never reached'); return 'x' })
} })
await ser
log(`  serial result=${JSON.stringify(await root.serial('release/notify', query))}`)

log('7. listeners are effects: dispose the plugin, the middleware is gone')
await redact.dispose()
log(`  result=${JSON.stringify(root.waterfall('release/query', query, inner))}`)
await root.fiber.dispose()
