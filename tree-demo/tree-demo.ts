/** One plugin, many mounts: config reload, isolate realms, and the HMR swap. */
import { Context, Service } from '@deepseek-ai/cordis'

interface NotifierConfig { channel: string; retries: number }

const log = (msg: string) => console.log(msg)
// 重载是异步的：await fiber 只等当前这轮，restart 排在之后，所以多让出几拍。
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const root = new Context()

log('1. one plugin, two configs -> one runtime, two fibers')
const notifier = {
  name: 'notifier',
  apply(ctx: Context, config: NotifierConfig) {
    log(`  apply: channel=${config.channel} retries=${config.retries} (fiber uid=${ctx.fiber.uid})`)
    ctx.effect(() => () => log(`  dispose: channel=${config.channel}`))
  },
}
const staging = root.plugin(notifier, { channel: '#staging', retries: 1 })
const prod = root.plugin(notifier, { channel: '#prod', retries: 5 })
await staging
await prod
// plugin() 返回的是 Object.create(fiber) 的包装（registry.ts:331），在它上面 update()
// 只会写到包装层。loader 存的也是 .ctx.fiber（entry.ts:188），这里照做。
const prodFiber = prod.ctx.fiber
const runtime = root.registry.get(notifier.apply)
log(`  registry entries=${root.registry.size} fibers of notifier=${[...runtime!.fibers].length}`)

log('2. update(config) is a full restart, not a patch')
prodFiber.update({ channel: '#prod', retries: 9 })
await settle()
log(`  staging untouched? channel=#staging still active: ${staging.state === 2}`)

log('3. a listener on internal/update can veto the restart')
const guard = root.plugin({ name: 'guard', apply(ctx: Context) {
  ctx.on('internal/update', function (this: any, config: any) {
    log(`  internal/update seen for <${this.name}>, swallowing it (no next() call)`)
  }, { global: true, prepend: true })
} })
await guard
prodFiber.update({ channel: '#prod', retries: 99 })
await settle()
log('  (no apply/dispose printed above -> the restart was vetoed)')
await guard.dispose()

log('4. isolate: same service name, two realms')
abstract class Store extends Service {
  static provide = 'store'
  abstract read(): string
}
class MemStore extends Store { read() { return 'memory' } }
class DiskStore extends Store { read() { return 'disk' } }

const realmA = root.isolate('store')
const realmB = root.isolate('store')
const a = realmA.plugin(MemStore)
const b = realmB.plugin(DiskStore)
await a
await b
const reader = (ctx: Context, tag: string) => ctx.plugin({
  name: `reader-${tag}`, inject: ['store'],
  apply(c: Context) { log(`  reader-${tag} sees store.read()=${c.store.read()}`) },
})
await reader(realmA, 'A')
await reader(realmB, 'B')
log(`  same symbol? ${realmA[Context.isolate].store === realmB[Context.isolate].store}`)

log('5. the isolate boundary: root has no store at all')
log(`  root.reflect.get('store') -> ${root.reflect.get('store', false)}`)

log('6. HMR core: delete the plugin, remount every fiber from its own _config')
const v2 = {
  name: 'notifier',
  apply(ctx: Context, config: NotifierConfig) {
    log(`  v2 apply: channel=${config.channel} retries=${config.retries} (fiber uid=${ctx.fiber.uid})`)
  },
}
const olds = [...runtime!.fibers].map(f => ({ parent: f.parent, config: f._config }))
root.registry.delete(notifier.apply)
for (const { parent, config } of olds) await parent.registry.plugin(v2, config)
log(`  remounted ${olds.length} fiber(s), each keeping its own config and parent context`)

await root.fiber.dispose()
