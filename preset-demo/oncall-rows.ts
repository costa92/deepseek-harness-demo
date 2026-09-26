/** A preset row for the demo: registers the named tools, an optional runbook section, and optional tool masks. */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ToolRestriction } from '@deepseek-ai/dsh-tools'

export const name = 'oncall-rows'
export const inject = ['tools', 'systemPrompt']

export interface Config {
  tools: string[]
  /** Read once when the row applies; later edits reach only a new generation. */
  runbook?: string
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
  if (config.runbook !== undefined) {
    const text = readFileSync(config.runbook, 'utf8').trim()
    ctx.effect(() => ctx.systemPrompt.section({ name: 'oncall:runbook', order: 10, text }))
  }
  const { restrict, allowOnJoin } = config
  if (restrict !== undefined) ctx.effect(() => ctx.tools.restrict(restrict))
  if (allowOnJoin !== undefined) {
    ctx.on('agent/created', ({ agent }) => { agent.ctx.tools.restrict({ allow: allowOnJoin }) })
  }
}
