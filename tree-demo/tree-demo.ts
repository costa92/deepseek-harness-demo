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
// 实现表是全局扁平字典，绕过作用域直接遍历就能拿到所有 realm 的实现。
const walked = Reflect.ownKeys(root.reflect.store)
  .map(key => root.reflect.store[key as symbol])
  .filter(impl => impl.name === 'store')
  .map(impl => (impl.value as Store).read())
log(`  but walking root.reflect.store -> ${walked.join(', ')}`)
assert.deepEqual(walked, ['memory', 'disk'])

log('6. HMR core: delete the plugin, remount every fiber from its own _config')
// v2 的 Config 是手写的 Standard Schema V1 对象，不依赖 schemastery，并补一个默认字段。
const v2 = {
  name: 'notifier',
  Config: { '~standard': {
    version: 1 as const,
    vendor: 'hand-written',
    validate: (value: any) => ({ value: { timeoutMs: 3000, ...value } }),
  } },
  apply(ctx: Context, config: NotifierConfig & { timeoutMs: number }) {
    log(`  v2 apply: channel=${config.channel} retries=${config.retries} timeoutMs=${config.timeoutMs} (fiber uid=${ctx.fiber.uid})`)
    applied.push(`v2 ${config.channel}:${config.retries}:${config.timeoutMs}`)
  },
}
const olds = [...runtime.fibers].map(f => ({ parent: f.parent, config: f._config as NotifierConfig }))
root.registry.delete(apply)
for (const { parent, config } of olds) await parent.registry.plugin(v2, config)
log(`  remounted ${olds.length} fiber(s), each keeping its own config and parent context`)
// 第 3 步被否决的那次 update 仍写进了 _config，重挂时生效。
assert.deepEqual(applied.slice(3), ['v2 #staging:1:3000', 'v2 #prod:99:3000'])

log('7. isolate with the same label: two contexts, one realm')
const shared = Symbol('shared-store')
const realmC = root.isolate('store', shared)
const realmD = root.isolate('store', shared)
await realmC.plugin(MemStore)
await reader(realmD, 'D')
log(`  same symbol? ${realmC[Context.isolate].store === realmD[Context.isolate].store}`)
assert.deepEqual(seen, ['memory', 'disk', 'memory'])
assert.equal(realmC[Context.isolate].store, realmD[Context.isolate].store)

log('8. internal/update without global only sees its own fiber')
const localSeen: string[] = []
const localApplied: string[] = []
const selfGuard = root.plugin({ name: 'self-guard', apply(ctx: Context, config: { v: number }) {
  localApplied.push(`self-guard:${config.v}`)
  ctx.on('internal/update', function () {
    localSeen.push(this.name)
    log(`  local listener saw <${this.name}>, swallowing it`)
  })
} }, { v: 1 })
const other = root.plugin({ name: 'other', apply(_ctx: Context, config: { v: number }) {
  localApplied.push(`other:${config.v}`)
  log(`  apply: other v=${config.v}`)
} }, { v: 1 })
await selfGuard
await other
other.ctx.fiber.update({ v: 2 })
await until(() => localApplied.includes('other:2'), 'other to restart')
selfGuard.ctx.fiber.update({ v: 2 })
await until(() => localSeen.length === 1, 'self-guard to see its own update')
await new Promise(r => setTimeout(r, 10))
log(`  listener saw: [${localSeen.join(', ')}]; applied: [${localApplied.join(', ')}]`)
assert.deepEqual(localSeen, ['self-guard'])
assert.deepEqual(localApplied, ['self-guard:1', 'other:1', 'other:2'])

log('9. update() on the wrapper returned by plugin()')
const wrapperApplied: string[] = []
const legacy = { name: 'legacy', apply(ctx: Context, config: { v: number }) {
  log(`  apply ${JSON.stringify(config)}`)
  wrapperApplied.push(`v${config.v}`)
  ctx.effect(() => () => { log(`  dispose ${JSON.stringify(config)}`) })
} }
const wrapper = root.plugin(legacy, { v: 1 })
await wrapper
const real = wrapper.ctx.fiber
wrapper.update({ v: 2 })
await wrapper
log(`  after await wrapper, v2 applied yet? ${wrapperApplied.includes('v2')}`)
assert.deepEqual(wrapperApplied, ['v1'])
await until(() => wrapperApplied.includes('v2'), 'the wrapper restart')
log(`  real fiber _config=${JSON.stringify(real._config)} config=${JSON.stringify(real.config)} state=${FiberState[real.state]}`)
log(`  wrapper own props: ${['_config', 'config', 'state', 'inertia'].filter(k => Object.hasOwn(wrapper, k)).join(', ')}`)
assert.deepEqual(real._config, { v: 1 })
assert.deepEqual(real.config, { v: 1 })
assert.equal(real.state, FiberState.ACTIVE)
assert.ok(Object.hasOwn(wrapper, 'state'))
// HMR 从 runtime.fibers 取到的是真 Fiber，重挂时用的是旧配置。
const legacyRuntime = root.registry.get(legacy.apply)
assert.ok(legacyRuntime)
const legacyOlds = [...legacyRuntime.fibers].map(f => ({ parent: f.parent, config: f._config }))
root.registry.delete(legacy.apply)
for (const { parent, config } of legacyOlds) await parent.registry.plugin({ name: 'legacy', apply: legacy.apply }, config)
log(`  remounted from runtime.fibers with ${JSON.stringify(legacyOlds[0].config)}`)
assert.deepEqual(wrapperApplied, ['v1', 'v2', 'v1'])

await root.fiber.dispose()
