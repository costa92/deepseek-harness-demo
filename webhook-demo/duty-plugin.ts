/** Mounted inside dsh by duty.cordis.patch.yml: a scripted model, one synthetic release tool, and a probe that writes session events to a file. */
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'duty-demo'
export const inject = ['tools', 'llm', 'agents']

export interface Config { probeFile: string; controlDir: string }
export const Config: Schema<Config> = Schema.object({
  probeFile: Schema.string().required(),
  controlDir: Schema.string().required(),
})

const text = (message: Message) => message.content.map(b => b.type === 'text' ? b.text : '').join('')

// 脚本化模型：把收到的每条消息的角色和来源记下来，再按最后一条输入决定动作。
class ScriptedModel extends LlmAdapter {
  private seq = 0
  constructor(private readonly probe: (record: object) => void) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 会话标题请求等内部调用不带用户或 webhook 消息，这里只记值班会话里的请求。
    const last = options.messages.findLast(m => ['user', 'webhook', 'tool'].includes(m.source.kind))
    if (last === undefined) {
      yield* this.reply('发布值班')
      return
    }
    this.probe({
      type: 'model/request',
      messages: options.messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, source: m.source.kind })),
      catalogListsRunbook: options.messages.some(m => m.source.kind === 'skill-catalog' && text(m).includes('release-runbook')),
    })
    const block = last.content[0]
    if (block?.type === 'tool-result') {
      const result = block.content.map(b => b.type === 'text' ? b.text : '').join('')
      yield* this.reply(block.isError === true ? `没有执行：${result}` : `已完成：${result}`)
      return
    }
    if (text(last).includes('加载 release-runbook')) {
      yield* this.toolCall('skill', { name: 'release-runbook' })
      return
    }
    const goal = /建目标 (\S+)/.exec(text(last))
    if (goal !== null) {
      yield* this.toolCall('create_goal', { objective: goal[1] })
      return
    }
    const deploy = /部署 (\S+) (\S+)/.exec(text(last))
    if (deploy !== null) {
      yield* this.toolCall('deploy_release', { service: deploy[1], version: deploy[2] })
      return
    }
    yield* this.reply('已收到告警')
  }
  private * reply(answer: string): Iterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
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

/** Register the scripted provider, the deploy tool, and the session probe.
 * @param ctx - Cordis context with the tools and llm services.
 * @param config - File the probe appends JSON lines to, and the directory the parent drops control files into.
 */
export function apply(ctx: Context, config: Config) {
  const probe = (record: object) => { appendFileSync(config.probeFile, `${JSON.stringify(record)}\n`) }
  ctx.effect(() => ctx.llm.registerAdapter(['scripted'], new ScriptedModel(probe)))
  ctx.tools.register(defineTool({
    name: 'deploy_release',
    description: 'Deploy one version of a service.',
    parameters: { service: { type: 'string', required: true }, version: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: args => Promise.resolve(`${args.service} ${args.version} 已部署`),
  }))
  // 部署审批门：父进程放下 gate-deploy 文件后，每次部署都要人确认（第 30 篇的写法）。
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'deploy_release' || !existsSync(join(config.controlDir, 'gate-deploy'))) return next()
    return { kind: 'ask', reason: '部署需要值班人确认' }
  })
  // 模拟 Web UI 的人类输入：父进程写 human-<sessionId>.txt，这里以 user 来源追加到该会话。
  ctx.effect(() => {
    const timer = setInterval(() => {
      for (const file of readdirSync(config.controlDir)) {
        const match = /^human-(.+)\.txt$/.exec(file)
        if (match === null) continue
        const path = join(config.controlDir, file)
        const content = readFileSync(path, 'utf8')
        rmSync(path)
        ctx.agents.get(match[1] as never)?.followup(createUserMessage({ content: [{ type: 'text', text: content }], source: { kind: 'user' } }))
      }
    }, 50)
    return () => { clearInterval(timer) }
  })
  // Cordis 里 warn 的级别（2）高于 exporter 默认的 info（1），不显式放开就收不到。这里把 webhook 的警告抄一份到探针文件。
  ctx.logger.exporter({
    levels: { default: 2 },
    export: ({ type, args }) => {
      const line = args.map(String).join(' ')
      if (type === 'warn' && line.startsWith('webhook')) probe({ type: 'log/warn', text: line })
    },
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') {
      probe({ type: 'user/message', session: session.id, source: event.data.source, text: text(event.data as Message) })
    } else if (event.type === 'tool/result' || event.type === 'turn/end' || event.type.startsWith('approval/')) {
      probe({ type: event.type, session: session.id, data: event.data })
    }
  })
}
