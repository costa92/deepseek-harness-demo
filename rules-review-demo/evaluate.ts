/** Replay a candidate rule over a fixed set of logged deploys, and gate its activation behind dsh's `ask` approval path. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DeployRecord } from './log-miner.ts'
import type { RuleSpec } from './rule-store.ts'

/** What a rule would have changed on the dataset. */
export interface ReplayResult {
  /** Executed deploys in the dataset. */
  readonly deploys: number
  /** Failed deploys the rule would have stopped. */
  readonly prevented: number
  /** Successful deploys the rule would have stopped. */
  readonly falseBlocks: number
}

/**
 * Replay executed deploys in platform-time order under one rule. A deploy the rule denies is dropped from the
 * replayed history, so it cannot feed later decisions; outcomes of the deploys that remain are taken as logged.
 * @param records - deploy records read from session logs.
 * @param spec - the rule to replay.
 */
export function replay(records: readonly DeployRecord[], spec: RuleSpec): ReplayResult {
  const executed = records.filter(r => r.kind === 'executed' && r.at !== undefined).sort((a, b) => a.at! - b.at!)
  const kept: DeployRecord[] = []
  let prevented = 0
  let falseBlocks = 0
  for (const r of executed) {
    const failures = kept.filter(e => e.service === r.service && e.version === r.version
      && e.outcome === 'failed' && r.at! - e.at! < spec.windowHours * 3600_000).length
    if (failures >= spec.threshold) {
      if (r.outcome === 'failed') prevented++
      else falseBlocks++
      continue
    }
    kept.push(r)
  }
  return { deploys: executed.length, prevented, falseBlocks }
}

/** Short fingerprint of the dataset: record count plus a hash of the sorted refs. */
export function datasetId(records: readonly DeployRecord[]): string {
  const refs = records.map(r => r.ref).sort().join('\n')
  return `${records.length}-${createHash('sha256').update(refs).digest('hex').slice(0, 8)}`
}

const summary = (ruleId: string, revision: number, dataset: string, r: ReplayResult) =>
  `启用 ${ruleId}@${revision}：数据集 ${dataset} 的 ${r.deploys} 次部署回放，少失败 ${r.prevented} 次、误拦成功 ${r.falseBlocks} 次`

export interface Config {
  /** The fixed dataset every evaluation replays. */
  records: readonly DeployRecord[]
  /** Clock stamped on evaluations. */
  now?: () => number
}

/** Plugin: an `activate_rule` tool whose calls ask for approval, with the host's own replay summary as the reason. */
export const name = 'rule-activation'
export const inject = ['tools', 'ruleStore']
export function apply(ctx: Context, config: Config): void {
  const dataset = datasetId(config.records)
  const specOf = (args: unknown) => {
    const { ruleId, revision } = (args ?? {}) as { ruleId?: unknown; revision?: unknown }
    if (typeof ruleId !== 'string' || typeof revision !== 'number') return undefined
    const spec = ctx.ruleStore.revision(ruleId, revision)?.spec
    return spec === undefined ? undefined : { ruleId, revision, spec }
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'activate_rule',
    description: 'Point a rule at one of its revisions. Requires human approval.',
    parameters: { ruleId: { type: 'string', required: true }, revision: { type: 'integer', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      await ctx.ruleStore.activate(args.ruleId, args.revision, '经审批启用')
      return `已启用 ${args.ruleId}@${args.revision}`
    },
  })))

  // 评测由宿主算，不信模型的转述；审批请求里不带参数，界面通常只展示 reason，所以要启用什么、评测如何都写进 reason。
  // 评测在返回 ask 之前写入，没到审批人手里的调用也会留一条；键用 `<会话 id>#<callId>`，callId 跨会话不保证唯一。
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'activate_rule') return next()
    const target = specOf(exec.arguments)
    if (target === undefined) return { kind: 'deny', reason: '要启用的规则版本不存在' }
    const result = replay(config.records, target.spec)
    await ctx.ruleStore.recordEvaluation(`${exec.agent?.session.id ?? '-'}#${exec.callId}`, {
      ruleId: target.ruleId, revision: target.revision, dataset, ...result, at: (config.now ?? Date.now)(),
    })
    return { kind: 'ask', reason: summary(target.ruleId, target.revision, dataset, result) }
  })
}
