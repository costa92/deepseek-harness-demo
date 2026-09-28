/** Mounted inside the dsh child process by duty.cordis.patch.yml: a scripted model, a synthetic release platform, and an approval gate on deploys. */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'duty-demo'
export const inject = ['tools', 'llm']

const text = (message: Message) => message.content.map(b => b.type === 'text' ? b.text : '').join('')

// 脚本化模型：看最后一条用户消息或工具结果决定动作。工具结果回来就把结果念一遍；用户消息按关键词调工具。
class ScriptedModel extends LlmAdapter {
  private seq = 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 只看用户和工具结果：请求末尾还有运行时上下文、技能目录等插件消息。
    const last = options.messages.findLast(m => m.source.kind === 'user' || m.source.kind === 'tool')
    const block = last?.content[0]
    if (block?.type === 'tool-result') {
      const result = block.content.map(b => b.type === 'text' ? b.text : '').join('')
      yield* this.reply(block.isError === true ? `没有执行：${result}` : `已完成：${result}`)
      return
    }
    // 会话标题请求里没有用户消息。
    if (last === undefined) {
      yield* this.reply('发布值班')
      return
    }
    const task = text(last)
    if (task.includes('模型故障')) throw new Error('scripted provider is down')
    const deploy = /部署 (\S+) (\S+)/.exec(task)
    if (deploy !== null) {
      yield* this.toolCall('deploy_release', { service: deploy[1], version: deploy[2] })
      return
    }
    const query = /查询 (\S+)/.exec(task)
    if (query !== null) {
      yield* this.toolCall('read_releases', { service: query[1] })
      return
    }
    const asked = options.messages.filter(m => m.source.kind === 'user').length
    yield* this.reply(`收到：${task}（这是本会话第 ${asked} 条用户消息）`)
  }
  private * reply(answer: string): Iterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: '按剧本回答' }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: '按剧本回答' } }
    yield { type: 'block-start', index: 1, blockType: 'text' }
    yield { type: 'block-end', index: 1, block: { type: 'text', text: answer } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  private * toolCall(tool: string, args: object): Iterable<StreamChunk> {
    const id = ToolCallId(`call-${++this.seq}`)
    const json = JSON.stringify(args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: tool, argumentsDelta: json }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool, arguments: json } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

/** Register the scripted provider, both release tools, and the deploy approval gate.
 * @param ctx - Cordis context with the tools and llm services.
 */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.llm.registerAdapter(['scripted'], new ScriptedModel()))
  const text = (value: string) => [{ type: 'text' as const, text: value }]
  ctx.tools.register(defineTool({
    name: 'read_releases',
    description: 'Read the latest synthetic releases of one service.',
    parameters: { service: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    execute: args => Promise.resolve(`${args.service} 最近一次发布 2.2，状态 succeeded`),
  }))
  // 真正“部署”的证据：子进程在工作目录里追加一行账本，父进程事后读它。
  ctx.tools.register(defineTool({
    name: 'deploy_release',
    description: 'Deploy one version of a service.',
    parameters: { service: { type: 'string', required: true }, version: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    execute(args) {
      appendFileSync(join(process.cwd(), 'deploys.jsonl'), `${JSON.stringify(args)}\n`)
      return Promise.resolve(`${args.service} ${args.version} 已部署`)
    },
  }))
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'deploy_release') return next()
    const args = exec.arguments as { service: string; version: string }
    return { kind: 'ask', reason: `部署 ${args.service} ${args.version} 需要值班人确认` }
  })
}
