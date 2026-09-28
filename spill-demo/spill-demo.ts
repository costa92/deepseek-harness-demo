/** Spill an oversized tool result to disk, read it back, fork, age it out, and compare with attachments. */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as checkpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import * as spillPolicy from '@deepseek-ai/dsh-spill-policy'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'

const log = (msg: string) => { console.log(msg) }
const root = mkdtempSync(join(tmpdir(), 'dsh-spill-demo-'))
process.once('exit', () => { rmSync(root, { recursive: true, force: true }) })
const spillRoot = join(root, 'spill')
const agentOptions = { provider: 'mock', model: 'mock' }

/** A model that replays a fixed script. */
class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly script: StreamChunk[][] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    assert.ok(entry, 'the scripted model ran out of replies')
    for (const chunk of entry) yield chunk
  }
}
const reply = (text: string): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const callTool = (rawId: string, name: string, args: object): StreamChunk[] => {
  const id = ToolCallId(rawId)
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** 2000 synthetic deploy-log lines; the only failures sit in the middle. */
const deployLog = (service: string) => Array.from({ length: 2000 }, (_, i) => {
  const n = String(i + 1).padStart(4, '0')
  const status = i >= 1000 && i < 1003 ? 'failed ' : 'success'
  return `demo-${n} ${service} 1.${i}.0 ${status} canary=ok duration=${40 + (i % 17)}s`
})
const fetchDeployLog = defineTool({
  name: 'fetch_deploy_log',
  description: 'Fetch the synthetic deploy log of one service.',
  parameters: { service: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { lines: { type: 'array', items: { type: 'string' }, required: true } } },
    render: (_args, value) => [{ type: 'text', text: value.lines.join('\n') }],
  },
  async execute(args) { return { lines: deployLog(args.service) } },
})

const boot = async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(checkpointPolicy)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(toolFs)
  // 与 base bundle 相同：spill-local 默认配置 + maxInlineBytes 50000；root 指到临时目录便于观察。
  await ctx.plugin(LocalSpillStore, { root: spillRoot })
  await ctx.plugin(spillPolicy, { maxInlineBytes: 50000 })
  const model = new ScriptedModel()
  ctx.llm.registerAdapter(['mock'], model)
  ctx.tools.register(fetchDeployLog)
  await ctx.plugin(AgentLoop, { agents: [] })
  const ask = async (a: Agent, text: string) => {
    const idle = new Promise<void>((resolve) => {
      const off = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === a && status === 'idle') { off(); resolve() }
      })
    })
    a.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await idle
    await ctx.sessions.flush(a.session)
  }
  return { ctx, model, ask }
}

// oxlint-disable-next-line typescript/no-deprecated -- the demo reads the whole log on purpose
const events = (a: Agent): readonly SessionEvent[] => a.session.snapshotEvents()
const textOf = (content: readonly { type: string; text?: string }[]) => content.map(b => b.text ?? '').join('')
const resultOf = (a: Agent, callId: string) => {
  const e = events(a).find(x => x.type === 'tool/result' && x.data.message.source.callId === callId)
  assert.ok(e?.type === 'tool/result', `no result for ${callId}`)
  return { text: textOf((e.data.message.content[0] as { content: { type: string; text?: string }[] }).content), error: e.data.error?.code }
}
const locatorIn = (text: string) => {
  const m = /Full formatted result stored at: (.+?)\. Use read/u.exec(text)
  assert.ok(m?.[1], 'the spill notice carries a locator')
  return m[1]
}
const failedIn = (text: string) => text.split('\n').filter(l => l.includes(' failed ')).map(l => l.split(' ')[0])
const bytes = (text: string) => Buffer.byteLength(text, 'utf8')
const sessionLogText = (id: string) => {
  const dir = join(root, 'sessions', '_no-cwd', id)
  const file = readdirSync(dir).find(f => f.endsWith('.jsonl'))
  assert.ok(file)
  return readFileSync(join(dir, file), 'utf8')
}
// spill 文件名带随机前缀，打印时遮掉，保证每次输出一致。
const mask = (s: string) => s.replaceAll(root, '<tmp>').replace(/\/[0-9a-f]{12}-/gu, '/<rand>-')
const rel = (p: string) => mask(p.slice(root.length + 1))

const P = SessionId('oncall-payment')
const F = SessionId('oncall-payment-fork')
let { ctx, model, ask } = await boot()

log('1. a 2000-line tool result is over maxInlineBytes: the full text goes to a file')
const full = deployLog('payment-api').join('\n')
model.script.push(callTool('call-1', 'fetch_deploy_log', { service: 'payment-api' }), reply('日志太长，只看到了开头和结尾。'))
const parent = (await ctx.agents.create({ sessionId: P, agentOptions })).agent
await ask(parent, '拉一下 payment-api 的发布日志')
const seen = resultOf(parent, 'call-1').text
const locator = locatorIn(seen)
const spilled = readFileSync(locator, 'utf8')
log(`  tool output ${bytes(full)} bytes -> model sees ${bytes(seen)} bytes (cap 50000)`)
log(`  notice: ${JSON.stringify(mask(seen.slice(seen.lastIndexOf('\n\n') + 2)))}`)
log(`  spill file ${rel(locator)}: ${bytes(spilled)} bytes, identical to the tool output: ${spilled === full}`)
log(`  failed releases in the spill file: ${failedIn(spilled).join(' ')}; in what the model sees: [${failedIn(seen).join(' ')}]`)
assert.ok(bytes(seen) <= 50000 && seen.startsWith('demo-0001 '))
assert.equal(spilled, full)
assert.deepEqual(failedIn(spilled), ['demo-1001', 'demo-1002', 'demo-1003'])
assert.deepEqual(failedIn(seen), [])
const preview = seen.slice(0, seen.lastIndexOf('\n\n(Omitted '))
assert.equal(Number(/\(Omitted (\d+) bytes\./u.exec(seen)?.[1]), bytes(full) - bytes(preview))
// 头尾预览直接拼接，接缝处没有省略标记。
const record = /^demo-\d{4} payment-api 1\.\d+\.0 (success|failed ) canary=ok duration=\d+s$/u
const rows = preview.split('\n')
const seam = rows.findIndex(l => !record.test(l))
log(`  preview seam, rows ${seam}-${seam + 2}: ${rows.slice(seam - 1, seam + 2).map(l => JSON.stringify(l)).join(' | ')}`)
assert.ok(seam > 0 && rows.slice(seam + 1).every(l => record.test(l)), 'exactly one partial row, at the seam')
const onDisk = sessionLogText(P)
log(`  session log on disk: ${bytes(onDisk)} bytes, contains "demo-1001": ${onDisk.includes('demo-1001')}, contains the locator: ${onDisk.includes(locator)}`)
assert.ok(!onDisk.includes('demo-1001') && onDisk.includes(locator), 'the log keeps only the preview and the locator')

log('2. the model follows the hint and reads the middle back with read')
model.script.push(callTool('call-2', 'read', { file_path: locator, offset: 1000, limit: 5 }), reply('第 1001 到 1003 次发布失败。'))
await ask(parent, '中间那段有没有失败？')
const readBack = resultOf(parent, 'call-2').text
log(mask(readBack).split('\n').slice(0, 8).map(l => `  | ${l}`).join('\n'))
assert.deepEqual(failedIn(readBack.replace(/^\d+: /gmu, '')), ['demo-1001', 'demo-1002', 'demo-1003'])

log('3. fork: the child inherits the parent locator; its own spills go to its own directory')
// oxlint-disable-next-line typescript/no-deprecated -- the demo copies the whole parent log on purpose
const seed = parent.session.snapshotEvents()
const cut = seed.findLastIndex(e => e.type === 'turn/end') + 1
const child = (await ctx.agents.create({
  sessionId: F, seed: seed.slice(0, cut), inheritedEventCount: SessionLogOffset(cut),
  meta: { parentSession: P, isSeeded: true }, agentOptions,
})).agent
model.script.push(callTool('call-3', 'fetch_deploy_log', { service: 'order-api' }), reply('order-api 的日志也存成文件了。'))
await ask(child, '再拉一下 order-api 的')
const childLocator = locatorIn(resultOf(child, 'call-3').text)
const hash = (id: string) => `session-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`
log(`  inherited locator: ${rel(locator)}  (${hash(P)} = sha256("${P}"))`)
log(`  child's own spill: ${rel(childLocator)}  (${hash(F)} = sha256("${F}"))`)
assert.equal(basename(dirname(locator)), hash(P))
assert.equal(basename(dirname(childLocator)), hash(F))
assert.ok(sessionLogText(F).includes(locator), 'the child log carries the parent locator verbatim')
await ctx.fiber.dispose()

log('4. restart after 31 days: the startup sweep deletes the old file, the log still points at it')
const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
utimesSync(locator, old, old)
;({ ctx, model, ask } = await boot())
for (let i = 0; i < 100 && existsSync(locator); i++) await sleep(20)
log(`  parent spill file exists: ${existsSync(locator)}; child spill file exists: ${existsSync(childLocator)}`)
assert.ok(!existsSync(locator) && existsSync(childLocator), 'cleanupPeriodDays defaults to 30')
const resumed = (await ctx.agents.resume({ resumeSessionId: F, agentOptions })).agent
model.script.push(callTool('call-4', 'read', { file_path: locator, offset: 1000, limit: 5 }), reply('文件不见了。'))
await ask(resumed, '再看一眼 payment-api 日志中间那段')
const gone = resultOf(resumed, 'call-4')
log(`  read(inherited locator) -> ${gone.error ?? 'ok'}: ${JSON.stringify(mask(gone.text))}`)
assert.equal(gone.error, 'FS_NOT_FOUND')

log('5. a spill file has no digest; an attachment does')
writeFileSync(childLocator, readFileSync(childLocator, 'utf8').replace('demo-0001 order-api 1.0.0 success', 'demo-0001 order-api 1.0.0 failed '))
model.script.push(callTool('call-5', 'read', { file_path: childLocator, offset: 1, limit: 1 }), reply('第一次发布失败了。'))
await ask(resumed, '看一下 order-api 第一行')
const edited = resultOf(resumed, 'call-5')
log(`  edited spill file, read -> ${edited.error ?? 'ok'}: ${JSON.stringify(edited.text.split('\n').find(l => l.includes('demo-0001')))}`)
assert.equal(edited.error, undefined)
assert.ok(edited.text.includes('demo-0001 order-api 1.0.0 failed '))
await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'dsh-home') })
const data = new TextEncoder().encode(full)
const first = await ctx.attachments.saveFile({ data, name: 'payment-api.log' })
const second = await ctx.attachments.saveFile({ data, name: 'payment-api.log' })
const stored = ctx.attachments.fileHostPath(first)
assert.ok(stored)
log(`  attachment: ${first.attachmentId.slice(0, 19)}… ${first.bytes} bytes, saved twice -> same id: ${first.attachmentId === second.attachmentId}`)
log(`  stored under ${rel(stored).split('/').slice(0, 4).join('/')}/…`)
assert.equal(first.attachmentId, second.attachmentId)
chmodSync(stored, 0o600)
writeFileSync(stored, full.replace('demo-0001 payment-api 1.0.0 success', 'demo-0001 payment-api 1.0.0 failed '))
const drain = async () => { for await (const chunk of ctx.attachments.readFileStream(first)) void chunk }
const err = await drain().then(() => undefined, (e: unknown) => e as { code?: string; message?: string })
log(`  edited attachment, readFileStream -> ${err?.code}: ${err?.message}`)
assert.equal(err?.code, 'ATTACHMENT_CORRUPT')

await ctx.fiber.dispose()
process.exit(0)
