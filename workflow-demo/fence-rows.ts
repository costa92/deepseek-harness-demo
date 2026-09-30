/** A preset row for the demo: masks tools at the preset's standing scope, which joining agents inherit. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'

export const name = 'fence-rows'
export const inject = ['tools']

export interface Config {
  restrict: ToolRestriction
}

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.tools.restrict(config.restrict))
}
