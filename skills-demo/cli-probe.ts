/** Mounted inside a dsh CLI child by cli-probe.cordis.patch.yml: a scripted model that answers with the skill catalog it was sent. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'

export const name = 'skills-cli-probe'
export const inject = ['llm']

// 模型把请求里 skill-catalog 消息的条目原样念回来，父进程从 stdout 读。
class CatalogEcho extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const lines = options.messages
      .filter(m => m.source.kind === 'skill-catalog')
      .flatMap(m => m.content.flatMap(b => b.type === 'text' ? b.text.split('\n') : []))
      .filter(line => line.startsWith('- `'))
    const text = lines.length === 0 ? '（请求里没有 skill 目录）' : lines.join('\n')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Register the catalog-echo model as `scripted/mock`.
 * @param ctx - Cordis context with the llm service.
 */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.llm.registerAdapter(['scripted'], new CatalogEcho()))
}
