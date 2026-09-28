/** Drive a release agent against a flaky scripted model provider: what dsh-llm-retry retries, what the log keeps, and what the meter counts. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, LlmError, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

const log = (msg: string) => { console.log(msg) }

// ── 脚本化的提供方：每次请求按剧本做一件事 ─────────────────────────────────────
// text：正常回答；call：调一次 deploy_release；rate：429；rate-late：429 且要求等 60 秒；
// plain：抛普通 Error；auth：认证失败；cut：调用块和用量都已流出后连接断开。
type Step = 'text' | 'call' | 'rate' | 'rate-late' | 'plain' | 'auth' | 'cut'
const usage = (inputTokens: number, outputTokens: number): StreamChunk => ({ type: 'usage', usage: { inputTokens, outputTokens } })
class FlakyProvider extends LlmAdapter {
  script: Step[] = []
  readonly requests: Message[][] = []
  onRequest: (n: number) => void = () => undefined
  constructor(private readonly policy?: ResolvedRetryPolicy) { super() }
  // 重试策略归提供方所有，在注册路由时读一次（dsh-llm index.ts:439）。
  override providerRetryPolicy(): ResolvedRetryPolicy | undefined { return this.policy }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options.messages)
    this.onRequest(this.requests.length)
    const step = this.script.shift()
    assert.ok(step, 'the scripted provider ran out of steps')
    if (step === 'rate') throw new LlmError('429 too many requests', 'RATE_LIMIT', { status: 429 })
    if (step === 'rate-late') throw new LlmError('429 retry later', 'RATE_LIMIT', { status: 429, providerRetryAfterMs: 60_000 })
    if (step === 'auth') throw new LlmError('401 invalid api key', 'AUTH', { status: 401 })
    if (step === 'plain') throw new Error('socket hang up')
    if (step === 'text') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '已处理。' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已处理。' } }
      yield usage(100, 5)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const id = ToolCallId(`call-${this.requests.length}`)
    const json = JSON.stringify({ service: 'payment-api', version: '2.5' })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: 'deploy_release', argumentsDelta: json }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'deploy_release', arguments: json } }
    yield usage(100, 20)
    if (step === 'cut') throw new LlmError('connection reset', 'TRANSPORT')
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

// ── 合成发布平台 ───────────────────────────────────────────────────────
let deploys = 0
const deployRelease = defineTool({
  name: 'deploy_release',
  description: 'Deploy one version of a service to the synthetic release platform.',
  parameters: { service: { type: 'string', required: true }, version: { type: 'string', required: true } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute(args) {
    deploys++
    return Promise.resolve(`${args.service} ${args.version} succeeded`)
  },
})

// ── 宿主 ───────────────────────────────────────────────────────────────
// 默认策略是 normal、最多 5 次、500 毫秒到 10 秒、10% 抖动；这里缩短延迟、去掉抖动，让输出可复现。
const NORMAL: ResolvedRetryPolicy = { mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMIT', 'TRANSPORT'], initialDelayMs: 20, maxDelayMs: 200, jitterRatio: 0 }
const ALWAYS: ResolvedRetryPolicy = { mode: 'always', initialDelayMs: 20, maxDelayMs: 200, jitterRatio: 0 }
interface Host { provider: FlakyProvider; agent: Agent; ctx: Context }
async function boot(id: string, options: { retry: boolean; policy?: ResolvedRetryPolicy }): Promise<Host> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TokenMeter)
  if (options.retry) await ctx.plugin(LlmRetry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const provider = new FlakyProvider(options.policy ?? NORMAL)
  ctx.llm.registerAdapter(['flaky'], provider)
  ctx.tools.register(deployRelease)
  const { agent } = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'flaky', model: 'mock' } })
  return { provider, agent, ctx }
}
async function ask(host: Host, text: string, ...script: Step[]): Promise<void> {
  host.provider.script.push(...script)
  host.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await host.agent.whenIdle()
  assert.equal(host.provider.script.length, 0)
}
// oxlint-disable-next-line typescript/no-deprecated -- the demo reads the whole log on purpose
const events = (host: Host): readonly SessionEvent[] => host.agent.session.snapshotEvents()
const turnEnd = (host: Host) => {
  const end = events(host).findLast(e => e.type === 'turn/end')
  assert.ok(end?.type === 'turn/end')
  const reason = end.data.reason
  if (reason.kind === 'error') return `error ${reason.error.code}（${reason.error.message}）`
  return reason.kind === 'aborted' ? `aborted（${reason.reason.kind}）` : reason.kind
}
const retries = (host: Host) => events(host).flatMap(e => e.type === 'llm/retry'
  ? [{ step: e.data.step, retry: e.data.retry, delayMs: e.data.delayMs, code: e.data.failure.code }]
  : [])
const kinds = (host: Host, types: string[]) => events(host).filter(e => types.includes(e.type)).map(e => e.type)
const tokens = (host: Host) => {
  const state = host.ctx.sessionProjections.stateOf(host.agent.session, 'tokenUsage')
  assert.ok(state)
  return `输入 ${state.totals.uncachedInputTokens}、输出 ${state.totals.outputTokens}`
}
const said = (message: Message) => `${message.role}/${message.source.kind}${message.role === 'user' && message.source.kind === 'user'
  ? `「${message.content.map(b => b.type === 'text' ? b.text : '').join('')}」` : ''}`
const ATTEMPTS = ['assistant/attempt', 'llm/retry', 'llm/retry-started', 'assistant/message']

log('== 1. 没挂 llm-retry：一次 429 就结束这一轮 ==')
const bare = await boot('bare', { retry: false })
await ask(bare, '发布 payment-api 2.5', 'rate')
const bareEnd = turnEnd(bare)
log(`本轮结束：${bareEnd}；whenIdle 正常返回`)
log(`日志：${kinds(bare, ATTEMPTS).join('、')}`)
await ask(bare, '再试一次', 'text')
const nextRequest = bare.provider.requests[1] ?? []
log(`用户再说一句，模型收到：${nextRequest.map(said).join('、')}`)
assert.equal(bareEnd, 'error RATE_LIMIT（429 too many requests）')
assert.deepEqual(kinds(bare, ATTEMPTS).slice(0, 1), ['assistant/attempt'])
assert.deepEqual(nextRequest.map(said), ['system/plugin', 'user/user「发布 payment-api 2.5」', 'user/user「再试一次」'])

log('\n== 2. 挂上 llm-retry：两次 429 后成功 ==')
const retried = await boot('retried', { retry: true })
await ask(retried, '发布 payment-api 2.5', 'rate', 'rate', 'text')
log(`本轮结束：${turnEnd(retried)}`)
const retriedKinds = kinds(retried, ATTEMPTS)
log(`日志：${retriedKinds.slice(0, 4).join('、')}、`)
log(`      ${retriedKinds.slice(4).join('、')}`)
log(`llm/retry：${retries(retried).map(r => `第 ${r.retry} 次等 ${r.delayMs} 毫秒（${r.code}）`).join('，')}`)
const [firstRequest, ...rest] = retried.provider.requests.map(r => JSON.stringify(r))
log(`${retried.provider.requests.length} 次请求的消息完全相同：${rest.every(r => r === firstRequest)}`)
log(`token 用量：${tokens(retried)}（失败的两次没有上报用量）`)
assert.equal(turnEnd(retried), 'completed')
assert.deepEqual(kinds(retried, ATTEMPTS), ['assistant/attempt', 'llm/retry', 'llm/retry-started', 'assistant/attempt', 'llm/retry', 'llm/retry-started', 'assistant/message'])
assert.deepEqual(retries(retried).map(r => r.delayMs), [20, 40])
assert.ok(rest.length === 2 && rest.every(r => r === firstRequest))
assert.equal(tokens(retried), '输入 100、输出 5')

log('\n== 3. 预算：maxRetries 是每一步的，不是每一轮的 ==')
const exhausted = await boot('exhausted', { retry: true })
await ask(exhausted, '发布 payment-api 2.5', 'rate', 'rate', 'rate')
log(`maxRetries = 2，连续 3 次 429：重试 ${retries(exhausted).length} 次后，本轮结束：${turnEnd(exhausted)}`)
const twoSteps = await boot('two-steps', { retry: true })
await ask(twoSteps, '发布 payment-api 2.5', 'rate', 'rate', 'call', 'rate', 'rate', 'text')
log(`两步各失败 2 次：重试记录 ${retries(twoSteps).map(r => `步${r.step}#${r.retry}`).join(' ')}，本轮结束：${turnEnd(twoSteps)}`)
assert.equal(retries(exhausted).length, 2)
assert.equal(turnEnd(exhausted), 'error RATE_LIMIT（429 too many requests）')
assert.deepEqual(retries(twoSteps).map(r => `${r.step}#${r.retry}`), ['1#1', '1#2', '2#1', '2#2'])
assert.equal(turnEnd(twoSteps), 'completed')

log('\n== 4. 调用块已经流出来，连接断了 ==')
const cut = await boot('cut', { retry: true })
deploys = 0
await ask(cut, '发布 payment-api 2.5', 'cut', 'call', 'text')
const failedAttempt = events(cut).find(e => e.type === 'assistant/attempt')
assert.ok(failedAttempt?.type === 'assistant/attempt')
const recorded = failedAttempt.data.stream.flatMap(r => r.type === 'tool-call-chunks' ? [`${r.name}(${r.args.join('')})`] : r.type === 'chunk' ? [r.chunk.type] : [])
log('失败那次的流记在 assistant/attempt 里：')
log(`  ${recorded.join('、')}`)
const [cutFirst, cutRetry] = cut.provider.requests.map(r => JSON.stringify(r))
log(`失败那次没有执行；重试请求的消息与失败那次相同：${cutFirst === cutRetry}`)
log(`重试后平台执行 ${deploys} 次，tool/call ${kinds(cut, ['tool/call']).length} 条`)
log(`token 用量：${tokens(cut)}（失败那次的 100/20 也算进去了）`)
assert.deepEqual(recorded, ['block-start', 'deploy_release({"service":"payment-api","version":"2.5"})', 'block-end', 'usage', 'finish'])
assert.equal(deploys, 1)
assert.ok(cutFirst !== undefined && cutFirst === cutRetry)
assert.equal(kinds(cut, ['tool/call']).length, 1)
assert.equal(tokens(cut), '输入 300、输出 45')

log('\n== 5. 哪些失败会重试 ==')
const verdicts: string[] = []
for (const [label, policy] of [['normal', NORMAL], ['always', ALWAYS]] as const) {
  for (const [what, failure] of [['普通 Error', 'plain'], ['429 且要求等 60 秒', 'rate-late']] as const) {
    const host = await boot(`${label}-${failure}`, { retry: true, policy })
    await ask(host, '发布 payment-api 2.5', failure, ...label === 'always' ? ['text' as const] : [])
    const done = retries(host)
    verdicts.push(`${label}：${what} -> ${done.length === 0 ? '不重试' : `重试，等 ${done.map(r => r.delayMs).join('/')} 毫秒`}，本轮 ${turnEnd(host).split('（')[0]}`)
  }
}
for (const v of verdicts) log(v)
assert.deepEqual(verdicts, [
  'normal：普通 Error -> 不重试，本轮 error UNKNOWN',
  'normal：429 且要求等 60 秒 -> 不重试，本轮 error RATE_LIMIT',
  'always：普通 Error -> 重试，等 20 毫秒，本轮 completed',
  'always：429 且要求等 60 秒 -> 重试，等 20 毫秒，本轮 completed',
])

log('\n== 6. always 模式遇到认证失败：直到用户取消 ==')
const stuck = await boot('stuck', { retry: true, policy: ALWAYS })
stuck.provider.onRequest = (n) => {
  if (n === 7) setTimeout(() => { stuck.agent.cancel({ kind: 'user' }) }, 0)
}
await ask(stuck, '发布 payment-api 2.5', ...Array.from({ length: 7 }, () => 'auth' as const))
log(`401 连续 ${stuck.provider.requests.length} 次，排了 ${retries(stuck).length} 次重试，等待 ${retries(stuck).map(r => r.delayMs).join('/')} 毫秒`)
log(`第 7 次请求发出时用户取消：llm/retry-started ${kinds(stuck, ['llm/retry-started']).length} 条，最后一次重试在等待中被中止`)
log(`本轮结束：${turnEnd(stuck)}`)
assert.equal(stuck.provider.requests.length, 7)
assert.deepEqual(retries(stuck).map(r => r.delayMs), [20, 40, 80, 160, 200, 200, 200])
assert.equal(turnEnd(stuck), 'aborted（user）')
assert.equal(kinds(stuck, ['llm/retry-started']).length, 6)
