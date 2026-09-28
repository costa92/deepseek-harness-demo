/** Show how Cordis effects make release-lookup's registrations reversible. */
import assert from 'node:assert/strict'
import { Context, FiberState, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context { toolbox: Toolbox }
  interface Events { 'release/changed'(id: string): void }
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
await root.fiber.dispose()
