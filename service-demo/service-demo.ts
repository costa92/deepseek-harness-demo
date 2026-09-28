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
const patched = Object.create(Object.getPrototypeOf(root.releases) as object) as Releases
Object.assign(patched, root.releases, { origin: 'file(updated)' })
fileFiber.ctx.set('releases', patched)
// 要证明的是"没有重载"，只能给它留出发生的时间再检查。
await new Promise(r => setTimeout(r, 10))
log(`  plugin state=${plugin.state}, ctx.releases.origin=${root.releases.origin}`)
log('  (no new apply() line above)')
assert.equal(root.releases.origin, 'file(updated)')
assert.deepEqual(applied, ['demo-001'])

log('5. swap the provider: dispose file source, then load platform source')
await fileFiber.dispose()
log(`  after dispose state=${plugin.state} (0=PENDING)`)
assert.equal(plugin.state, FiberState.PENDING)
const platformFiber = root.plugin(PlatformReleases)
await platformFiber
await plugin
log(`  state=${plugin.state} (2=ACTIVE)`)
assert.equal(plugin.state, FiberState.ACTIVE)
assert.deepEqual(applied, ['demo-001', 'plat-77'])

log('6. read without inject')
log(`  ctx.get("releases").origin=${root.get('releases')?.origin}`)
assert.equal(root.get('releases')?.origin, 'platform')
await root.fiber.dispose()
