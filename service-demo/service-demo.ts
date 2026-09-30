/** Swap the release data source behind release-lookup without touching the plugin. */
import assert from 'node:assert/strict'
import { Context, FiberState, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context { releases: Releases }
}

const log = (msg: string) => { console.log(msg) }

export interface Release { id: string; service: string; version: string; status: 'succeeded' | 'failed' }

/** Contract both data sources implement; the plugin only knows this shape. */
abstract class Releases extends Service {
  constructor(ctx: Context) { super(ctx, 'releases') }
  abstract origin: string
  abstract list(service: string): Promise<Release[]>
}

/** Source A: records shipped with the demo, stands in for releases.json. */
class FileReleases extends Releases {
  origin = 'file'
  records: Release[] = [{ id: 'demo-001', service: 'payment-api', version: '1.4.0', status: 'succeeded' }]
  async list(service: string) { return this.records.filter(r => r.service === service) }
}

/** Source B: stands in for a release platform API; same contract, different data. */
class PlatformReleases extends Releases {
  origin = 'platform'
  async list(service: string) {
    return [{ id: 'plat-77', service, version: '2.0.1', status: 'failed' as const }]
  }
}

const applied: string[] = []
const releaseLookup = { name: 'release-lookup', inject: ['releases'], async apply(ctx: Context) {
  log(`  apply() ran, origin=${ctx.releases.origin}`)
  const records = await ctx.releases.list('payment-api')
  log(`  lookup_release -> ${JSON.stringify(records)}`)
  applied.push(...records.map(r => r.id))
} }

const root = new Context()

log('1. plugin loads before any releases service')
const plugin = root.plugin(releaseLookup)
log(`  state=${plugin.state} (0=PENDING)`)
assert.equal(plugin.state, FiberState.PENDING)

log('2. provide the file-backed source')
const fileFiber = root.plugin(FileReleases)
await fileFiber
await plugin
log(`  state=${plugin.state} (2=ACTIVE)`)
assert.equal(plugin.state, FiberState.ACTIVE)
assert.deepEqual(applied, ['demo-001'])

log('3. register a second releases service in the same scope')
const second = root.plugin(PlatformReleases)
await assert.rejects(async () => { await second }, (e: Error) => {
  log(`  ${e.message}`)
  return e.message.includes('has been registered')
})
await second.dispose()

log('4. ctx.set on the live service: change value, keep the provider fiber')
const held = root.releases
const patched = Object.create(Object.getPrototypeOf(root.releases) as object) as Releases
Object.assign(patched, root.releases, { origin: 'file(updated)' })
fileFiber.ctx.set('releases', patched)
// 要证明的是"没有重载"，只能给它留出发生的时间再检查。
await new Promise(r => setTimeout(r, 10))
log(`  plugin state=${plugin.state}, ctx.releases.origin=${root.releases.origin}`)
log('  (no new apply() line above)')
log(`  reference held before set: origin=${held.origin}`)
assert.equal(held.origin, 'file')
assert.equal(root.releases.origin, 'file(updated)')
assert.deepEqual(applied, ['demo-001'])

log('5. swap the provider: dispose file source, then load platform source')
await fileFiber.dispose()
log(`  after dispose state=${plugin.state} (0=PENDING), ctx.get("releases")=${root.get('releases')}`)
assert.equal(plugin.state, FiberState.PENDING)
assert.equal(root.get('releases'), undefined)
const platformFiber = root.plugin(PlatformReleases)
await platformFiber
await plugin
log(`  state=${plugin.state} (2=ACTIVE)`)
assert.equal(plugin.state, FiberState.ACTIVE)
assert.deepEqual(applied, ['demo-001', 'plat-77'])

log('6. read without inject')
log(`  ctx.get("releases").origin=${root.get('releases')?.origin}`)
assert.equal(root.get('releases')?.origin, 'platform')

log('7. this.ctx inside the service, read through a consumer')
let seenCtx = ''
const probe = root.plugin({ name: 'probe', inject: { releases: {} }, apply(ctx: Context) {
  seenCtx = (ctx.releases as unknown as { ctx: Context }).ctx.fiber.name
} })
await probe
log(`  provider fiber=<${platformFiber.name}>, service this.ctx.fiber=<${seenCtx}>`)
assert.equal(seenCtx, 'probe')
await probe.dispose()

log('8. read ctx.releases without declaring inject')
let noInject = ''
const bare = root.plugin({ name: 'bare', apply(ctx: Context) {
  try { void ctx.releases } catch (e) { noInject = (e as Error).message }
} })
await bare
log(`  ${noInject}`)
assert.match(noInject, /without inject/)
await bare.dispose()

log('9. ctx.set from a consumer fiber')
assert.throws(() => plugin.ctx.set('releases', patched), (e: Error) => {
  log(`  ${e.message}`)
  return e.message.includes('in multiple fibers')
})

log('10. same name in an isolated scope')
const scope = root.isolate('releases')
const isolated = scope.plugin(FileReleases)
await isolated
log(`  root origin=${root.get('releases')?.origin}, isolated origin=${scope.get('releases')?.origin}`)
assert.equal(root.get('releases')?.origin, 'platform')
assert.equal(scope.get('releases')?.origin, 'file')
await isolated.dispose()

log('11. get(name) vs get(name, false) while the provider is still loading')
let strictSeen: unknown = 'unset'
let looseSeen: unknown = 'unset'
let stateDuring = -1
const slow = root.plugin({ name: 'slow-provider', async apply(ctx: Context) {
  ctx.provide('draft', { v: 1 })
  stateDuring = ctx.fiber.state
  strictSeen = root.get('draft')
  looseSeen = root.get('draft', false)
  await new Promise(r => setTimeout(r, 10))
} })
await slow
log(`  provider state during apply=${stateDuring} (1=LOADING): get=${JSON.stringify(strictSeen)}, get(false)=${JSON.stringify(looseSeen)}`)
log(`  after apply state=${slow.state}: get=${JSON.stringify(root.get('draft'))}`)
assert.equal(stateDuring, FiberState.LOADING)
assert.equal(strictSeen, undefined)
assert.deepEqual(looseSeen, { v: 1 })
assert.deepEqual(root.get('draft'), { v: 1 })
await slow.dispose()

await plugin.dispose()

log('12. ctx.inject child follows the provider')
const childLog: string[] = []
let childFiber!: ReturnType<Context['inject']>
const host = root.plugin({ name: 'host', apply(ctx: Context) {
  childFiber = ctx.inject(['releases'], (child) => {
    child.effect(() => {
      childLog.push(`up:${child.releases.origin}`); log(`  child up, origin=${child.releases.origin}`)
      return () => { childLog.push('down'); log('  child down') }
    })
  })
} })
await host
await platformFiber.dispose()
log(`  after provider dispose: host state=${host.state}, child state=${childFiber.state}`)
assert.equal(host.state, FiberState.ACTIVE)
assert.equal(childFiber.state, FiberState.PENDING)
const again = root.plugin(FileReleases)
await again
await childFiber
log(`  after new provider: child state=${childFiber.state}`)
assert.equal(childFiber.state, FiberState.ACTIVE)
assert.deepEqual(childLog, ['up:platform', 'down', 'up:file'])

log('13. dispose root')
await root.fiber.dispose()
