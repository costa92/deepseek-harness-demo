/** A preset row for the demo: registers the named tools and an optional tool mask at the preset's standing scope. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolRestriction } from '@deepseek-ai/dsh-tools'

export const name = 'oncall-rows'
export const inject = ['tools']

export interface Config {
  tools: string[]
  /**
   * Passed verbatim to ctx.tools.restrict() at the preset's standing scope: it masks everything
   * joined agents inherit, this preset's own tools included, and may name only global tools.
   */
  restrict?: ToolRestriction
}

export function apply(ctx: Context, config: Config): void {
  for (const tool of config.tools) {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: tool,
      description: `demo tool ${tool}`,
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: () => Promise.resolve(`${tool} ok`),
    })))
  }
  const { restrict } = config
  if (restrict !== undefined) ctx.effect(() => ctx.tools.restrict(restrict))
}
