/** Show how Cordis effects make release-lookup's registrations reversible. */
import assert from 'node:assert/strict'
import { Context, FiberState, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context { toolbox: Toolbox }
  interface Events { 'release/changed'(id: string): void; 'demo/drain'(id: string): void }
}

const log = (msg: string) => { console.log(msg) }

/** Minimal stand-in for ctx.tools: a name → description map. */
class Toolbox extends Service {
  tools = new Map<string, string>()
  constructor(ctx: Context) { super(ctx, 'toolbox') }
  register(name: string, description: string) {
    return this.ctx.effect(() => {
      this.tools.set(name, description)
      log(`  + tool ${name}`)
      return () => { this.tools.delete(name); log(`  - tool ${name}`) }
    }, `toolbox.register("${name}")`)
  }
}

const seen: string[] = []
const releaseLookup = { name: 'release-lookup', inject: ['toolbox'], apply(ctx: Context) {
  ctx.toolbox.register('lookup_release', 'query release history')
  ctx.effect(function* () {
    const timer = setInterval(() => {}, 60_000)
    log('  + cache timer')
    yield () => { clearInterval(timer); log('  - cache timer') }
    log('  + cache map')
    yield () => { log('  - cache map') }
  }, 'release cache')
  ctx.on('release/changed', id => { seen.push(id); log(`  release changed: ${id}`) })
} }

const root = new Context()

log('1. load plugin before toolbox exists')
const fiber = root.plugin(releaseLookup)
log(`  state=${fiber.state} (0=PENDING)`)
assert.equal(fiber.state, FiberState.PENDING)

log('2. provide toolbox')
const toolboxFiber = root.plugin(Toolbox)
await toolboxFiber
await fiber
log(`  state=${fiber.state} (2=ACTIVE) tools=${[...root.toolbox.tools.keys()]}`)
assert.equal(fiber.state, FiberState.ACTIVE)
root.emit('release/changed', 'demo-003')

log('3. dispose release-lookup')
await fiber.dispose()
log(`  tools=[${[...root.toolbox.tools.keys()]}]`)
assert.equal(root.toolbox.tools.size, 0)
root.emit('release/changed', 'demo-004')
log('  (no listener output above)')
assert.deepEqual(seen, ['demo-003'])

log('4. effect on disposed fiber')
assert.throws(() => fiber.ctx.effect(() => () => {}), (e: Error & { code?: string }) => {
  log(`  ${e.name}: ${e.code}`)
  return e.code === 'INACTIVE_EFFECT'
})

log('5. dispose toolbox while a new plugin depends on it')
const again = root.plugin(releaseLookup)
await again
await toolboxFiber.dispose()
log(`  dependent state=${again.state} (0=PENDING)`)
assert.equal(again.state, FiberState.PENDING)

log('6. provide toolbox again')
const toolboxAgain = root.plugin(Toolbox)
await toolboxAgain
await again
log(`  dependent state=${again.state} (2=ACTIVE) tools=${[...root.toolbox.tools.keys()]}`)
assert.equal(again.state, FiberState.ACTIVE)
assert.deepEqual([...root.toolbox.tools.keys()], ['lookup_release'])

log('7. call one disposer twice')
let closed = 0
const once = again.ctx.effect(() => () => { closed++ })
once()
once()
log(`  disposer ran ${closed} time(s)`)
assert.equal(closed, 1)

log('8. effect while the fiber is unloading')
let unloadingError: (Error & { code?: string }) | undefined
const reentrant = root.plugin({ name: 'reentrant', apply(ctx: Context) {
  ctx.effect(() => () => {
    log(`  state=${ctx.fiber.state} (5=UNLOADING)`)
    try { ctx.effect(() => () => {}) } catch (e) { unloadingError = e as Error & { code?: string } }
  })
} })
await reentrant
await reentrant.dispose()
log(`  ${unloadingError?.name}: ${unloadingError?.code}`)
assert.equal(unloadingError?.code, 'INACTIVE_EFFECT')

log('9. async disposer yielded last in a generator effect')
const composite = (label: string, yieldListener: boolean) => ({ name: label, apply(ctx: Context) {
  ctx.effect(function* () {
    const off = ctx.on('demo/drain', id => { drained.push(`${label}:${id}`); log(`  listener still on: ${id}`) })
    if (yieldListener) yield off
    yield async () => {
      log(`  ${label}: async disposer start, emit ${label}`)
      root.emit('demo/drain', label)
      await new Promise(r => setTimeout(r, 20))
      log(`  ${label}: async disposer end`)
    }
  })
} })
const drained: string[] = []
for (const [label, yieldListener] of [['bare-on', false], ['yield-on', true]] as const) {
  const fiber = root.plugin(composite(label, yieldListener))
  await fiber
  await fiber.dispose()
}
assert.deepEqual(drained, ['yield-on:yield-on'])

log('10. two async effects on one fiber unload concurrently')
const timeline: string[] = []
const slowFast = root.plugin({ name: 'slow-fast', apply(ctx: Context) {
  const effect = (label: string, ms: number) => ctx.effect(() => async () => {
    timeline.push(`${label} start`); log(`  ${label} start`)
    await new Promise(r => setTimeout(r, ms))
    timeline.push(`${label} end`); log(`  ${label} end`)
  })
  effect('A(10ms)', 10)
  effect('B(50ms)', 50)
} })
await slowFast
await slowFast.dispose()
assert.deepEqual(timeline, ['B(50ms) start', 'A(10ms) start', 'A(10ms) end', 'B(50ms) end'])

log('11. dispose root')
await root.fiber.dispose()
