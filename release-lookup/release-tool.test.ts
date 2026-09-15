import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from './release-tool.ts'

const fixture = await readFile(new URL('./releases.json', import.meta.url), 'utf8')

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-release-'))
  const recordsPath = join(dir, 'releases.json')
  await writeFile(recordsPath, fixture)
  const ctx = new Context()
  const system = await ctx.plugin(SystemPrompt)
  const tools = await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(plugin, { recordsPath })
  t.after(async () => { await fiber.dispose(); await tools.dispose(); await system.dispose(); await rm(dir, { recursive: true, force: true }) })
  let sequence = 0
  const call = (args: Record<string, unknown>) => ctx.tools.execute({
    callId: ToolCallId(`release-${++sequence}`), name: 'lookup_release', arguments: args,
    signal: new AbortController().signal,
  })
  return { ctx, fiber, recordsPath, call }
}

test('exposes schema and returns only production records, newest first', async t => {
  const { ctx, call } = await setup(t)
  assert.ok(ctx.tools.schemas().some(tool => tool.name === 'lookup_release'))
  const result = await call({ service: 'payment-api', environment: 'production' })
  assert.equal(result.isError, false)
  assert.deepEqual(result.value, { status: 'found', records: [JSON.parse(fixture)[2], JSON.parse(fixture)[0]] })
  assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(result.value) }])
})

test('staging is isolated from production', async t => {
  const { call } = await setup(t)
  const result = await call({ service: 'payment-api', environment: 'staging' })
  assert.deepEqual(result.value, { status: 'found', records: [JSON.parse(fixture)[1]] })
})

test('unknown service is a successful not_found outcome', async t => {
  const { call } = await setup(t)
  const result = await call({ service: 'unknown-api', environment: 'production' })
  assert.equal(result.isError, false)
  assert.deepEqual(result.value, { status: 'not_found', records: [] })
})

for (const [label, args] of [
  ['invalid environment', { service: 'payment-api', environment: 'prod' }],
  ['missing environment', { service: 'payment-api' }],
  ['wrong service type', { service: 123, environment: 'production' }],
  ['blank service', { service: ' ', environment: 'production' }],
] as const) {
  test(label, async t => {
    const { call } = await setup(t)
    const result = await call(args)
    assert.equal(result.isError, true)
    assert.equal(result.value, undefined)
  })
}

test('file failures are errors, never not_found', async t => {
  const { recordsPath, call } = await setup(t)
  for (const contents of ['{', '[{"service":"payment-api"}]']) {
    await writeFile(recordsPath, contents)
    assert.equal((await call({ service: 'payment-api', environment: 'production' })).isError, true)
  }
  await rm(recordsPath)
  assert.equal((await call({ service: 'payment-api', environment: 'production' })).isError, true)
})

test('a changed dataset is read on the next invocation', async t => {
  const { recordsPath, call } = await setup(t)
  await writeFile(recordsPath, '[]')
  assert.deepEqual((await call({ service: 'payment-api', environment: 'production' })).value, { status: 'not_found', records: [] })
})

test('disposing the plugin unregisters the tool', async t => {
  const { ctx, fiber } = await setup(t)
  await fiber.dispose()
  assert.equal(ctx.tools.schemas().some(tool => tool.name === 'lookup_release'), false)
})


test('invalid and impossible UTC dates fail instead of affecting ordering', async t => {
  const { recordsPath, call } = await setup(t)
  for (const deployedAt of ['yesterday', '2026-02-30T03:00:00Z']) {
    const records = JSON.parse(fixture)
    records[0].deployedAt = deployedAt
    await writeFile(recordsPath, JSON.stringify(records))
    assert.equal((await call({ service: 'payment-api', environment: 'production' })).isError, true)
  }
})
