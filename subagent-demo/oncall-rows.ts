/** A preset row for the demo: registers the named tools, an optional tool mask at the preset's standing scope, and an optional join-time allow-list. */
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
  /** Allow-list applied at each joining agent's own scope, from the scope-delivered `agent/created`. */
  allowOnJoin?: string[]
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
  const { restrict, allowOnJoin } = config
  if (restrict !== undefined) ctx.effect(() => ctx.tools.restrict(restrict))
  if (allowOnJoin !== undefined) {
    ctx.on('agent/created', ({ agent }) => { agent.ctx.tools.restrict({ allow: allowOnJoin }) })
  }
}
