/** One plugin, many mounts: config reload, isolate realms, and the HMR swap. */
import assert from 'node:assert/strict'
import { Context, FiberState, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context { store: Store }
}

interface NotifierConfig { channel: string; retries: number }

const log = (msg: string) => { console.log(msg) }
// 重载是异步的：await fiber 只等当前这轮，restart 排在之后，所以按条件等。
const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 1000; i++) {
    if (cond()) return
    await new Promise(r => setImmediate(r))
  }
  throw new Error(`timed out waiting for ${what}`)
}
const root = new Context()

log('1. one plugin, two configs -> one runtime, two fibers')
const applied: string[] = []
function apply(ctx: Context, config: NotifierConfig) {
  log(`  apply: channel=${config.channel} retries=${config.retries} (fiber uid=${ctx.fiber.uid})`)
  applied.push(`${config.channel}:${config.retries}`)
  ctx.effect(() => () => { log(`  dispose: channel=${config.channel}`) })
}
const notifier = { name: 'notifier', apply }
const staging = root.plugin(notifier, { channel: '#staging', retries: 1 })
const prod = root.plugin(notifier, { channel: '#prod', retries: 5 })
await staging
await prod
// plugin() 返回的是 Object.create(fiber) 的包装（registry.ts:331），在它上面 update()
// 只会写到包装层。loader 存的也是 .ctx.fiber（entry.ts:188），这里照做。
const prodFiber = prod.ctx.fiber
const runtime = root.registry.get(apply)
assert.ok(runtime)
log(`  registry entries=${root.registry.size} fibers of notifier=${[...runtime.fibers].length}`)
assert.equal([...runtime.fibers].length, 2)

log('2. update(config) is a full restart, not a patch')
prodFiber.update({ channel: '#prod', retries: 9 })
await until(() => applied.includes('#prod:9'), 'prod to restart')
log(`  staging untouched? channel=#staging still active: ${staging.state === FiberState.ACTIVE}`)
assert.equal(prod.ctx.fiber.uid, 2)
assert.deepEqual(applied, ['#staging:1', '#prod:5', '#prod:9'])

log('3. a listener on internal/update can veto the restart')
let vetoed = 0
const guard = root.plugin({ name: 'guard', apply(ctx: Context) {
  ctx.on('internal/update', function () {
    vetoed++
    log(`  internal/update seen for <${this.name}>, swallowing it (no next() call)`)
  }, { global: true, prepend: true })
} })
await guard
prodFiber.update({ channel: '#prod', retries: 99 })
await until(() => vetoed === 1, 'the guard to see the update')
// 要证明的是"没有重启"，只能给它留出发生的时间再检查。
await new Promise(r => setTimeout(r, 10))
log('  (no apply/dispose printed above -> the restart was vetoed)')
assert.equal(applied.length, 3)
await guard.dispose()

log('4. isolate: same service name, two realms')
abstract class Store extends Service {
  constructor(ctx: Context) { super(ctx, 'store') }
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
const seen: string[] = []
const reader = (ctx: Context, tag: string) => ctx.plugin({
  name: `reader-${tag}`, inject: ['store'],
  apply(c: Context) { seen.push(c.store.read()); log(`  reader-${tag} sees store.read()=${c.store.read()}`) },
})
await reader(realmA, 'A')
await reader(realmB, 'B')
assert.deepEqual(seen, ['memory', 'disk'])
log(`  same symbol? ${realmA[Context.isolate].store === realmB[Context.isolate].store}`)
assert.notEqual(realmA[Context.isolate].store, realmB[Context.isolate].store)

log('5. the isolate boundary: root has no store at all')
log(`  root.reflect.get('store') -> ${root.reflect.get('store', false)}`)
assert.equal(root.reflect.get('store', false), undefined)

log('6. HMR core: delete the plugin, remount every fiber from its own _config')
const v2 = {
  name: 'notifier',
  apply(ctx: Context, config: NotifierConfig) {
    log(`  v2 apply: channel=${config.channel} retries=${config.retries} (fiber uid=${ctx.fiber.uid})`)
    applied.push(`v2 ${config.channel}:${config.retries}`)
  },
}
const olds = [...runtime.fibers].map(f => ({ parent: f.parent, config: f._config as NotifierConfig }))
root.registry.delete(apply)
for (const { parent, config } of olds) await parent.registry.plugin(v2, config)
log(`  remounted ${olds.length} fiber(s), each keeping its own config and parent context`)
// 第 3 步被否决的那次 update 仍写进了 _config，重挂时生效。
assert.deepEqual(applied.slice(3), ['v2 #staging:1', 'v2 #prod:99'])

await root.fiber.dispose()
