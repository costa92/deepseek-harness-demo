/** Mounted inside a dsh CLI child by cli-probe.cordis.patch.yml: a scripted model that answers with the instruction section headers it was sent. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'

export const name = 'instructions-cli-probe'
export const inject = ['llm']

// 模型把请求里 agent-instructions 消息的预算行和各段标题原样念回来，父进程从 stdout 读。
class HeaderEcho extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const lines = options.messages
      .filter(m => m.source.kind === 'agent-instructions')
      .flatMap(m => m.content.flatMap(b => b.type === 'text' ? b.text.split('\n') : []))
      .filter(line => /^(Workspace instruction budget|Instructions from|Additional instructions from|Updated instructions from|Instructions removed)/.test(line))
    const text = lines.length === 0 ? '（请求里没有指令文件）' : lines.join('\n')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Register the header-echo model as `scripted/mock`.
 * @param ctx - Cordis context with the llm service.
 */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.llm.registerAdapter(['scripted'], new HeaderEcho()))
}
