/** A release-risk rule engine built on dsh's tool pipeline: tools/result feeds history, a guard blocks, post-execute warns. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/cordis' {
  interface Context { releaseRules: ReleaseRules }
}

/** One observed deployment outcome. */
export interface ReleaseEvent {
  readonly service: string
  readonly version: string
  readonly outcome: 'succeeded' | 'failed'
  readonly at: number
}

/** What a rule sees: the release in question, everything observed so far, and the engine clock. */
export interface RuleInput {
  readonly service: string
  readonly version: string
  readonly history: readonly ReleaseEvent[]
  readonly now: number
}

/** `block` stops the deploy tool; `warn` only annotates lookups. */
export interface ReleaseRule {
  readonly id: string
  readonly severity: 'block' | 'warn'
  /** Returns a finding message when the rule fires. Must be synchronous: guards cannot await. */
  evaluate(input: RuleInput): string | undefined
}

/** One fired rule. */
export interface Finding {
  readonly ruleId: string
  readonly severity: 'block' | 'warn'
  readonly message: string
}

export interface Config {
  /** Tool whose results are recorded and whose calls block rules may deny. */
  deployTool?: string
  /** Tool whose results warn rules annotate. */
  lookupTool?: string
  /** Map raw tool arguments to the key the rules compare; defaults to the raw strings. */
  normalize?: (service: string, version: string) => { service: string; version: string }
  /** Injectable clock for the time windows. */
  now?: () => number
  /** Also record every failed deploy-tool result (guard denials included) as a failed release; off by default. */
  recordErrors?: boolean
}

type Args = { service?: unknown; version?: unknown }
const text = (value: unknown) => typeof value === 'string' ? value : undefined

/** In-memory history plus a rule registry; the three pipeline hooks live and die with this service. */
export class ReleaseRules extends Service {
  static inject = ['tools']
  private readonly rules = new Map<string, ReleaseRule>()
  private readonly events: ReleaseEvent[] = []
  private readonly config: Required<Config>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'releaseRules')
    this.config = {
      deployTool: config.deployTool ?? 'deploy_release',
      lookupTool: config.lookupTool ?? 'lookup_release',
      normalize: config.normalize ?? ((service, version) => ({ service, version })),
      now: config.now ?? Date.now,
      recordErrors: config.recordErrors ?? false,
    }
    const { deployTool, lookupTool } = this.config

    // 1. 事实来源：观察部署工具的最终结果，写进历史。部署失败是工具正常返回的数据；
    //    工具报错（含被守卫拒绝）的结果里没有可区分的错误码，默认不记。
    ctx.on('tools/result', (exec, result) => {
      if (exec.name !== deployTool) return undefined
      if (result.isError) {
        const key = this.config.recordErrors ? this.keyOf(exec.arguments) : undefined
        if (key !== undefined) this.events.push({ ...key, outcome: 'failed', at: this.config.now() })
        return undefined
      }
      const outcome = (result.value as { outcome?: unknown } | null)?.outcome
      const key = this.keyOf(exec.arguments)
      if (key === undefined || (outcome !== 'succeeded' && outcome !== 'failed')) return undefined
      this.events.push({ ...key, outcome, at: this.config.now() })
      return undefined
    })

    // 2. 拦截：守卫只能拒绝，不会被前面的 pre-execute 监听器放行（第 9 篇）。
    ctx.tools.guard((exec) => {
      if (exec.name !== deployTool) return undefined
      const key = this.keyOf(exec.arguments)
      if (key === undefined) return undefined
      const blocking = this.evaluate(key.service, key.version).filter(f => f.severity === 'block')
      return blocking.length === 0 ? undefined : blocking.map(f => `[${f.ruleId}] ${f.message}`).join('; ')
    })

    // 3. 告警：查询结果照常返回，另外给下一次模型请求追加一条上下文。
    //    先让内层监听器做完决定，只在最终 accept 时追加告警。
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (exec.name !== lookupTool || result.isError || decision.kind !== 'accept') return decision
      const service = text((exec.arguments as Args | undefined)?.service)
      if (service === undefined) return decision
      const warnings = this.versionsOf(service).flatMap(version => this.evaluate(service, version))
        .filter(f => f.severity === 'warn')
      if (warnings.length === 0) return decision
      const alert = createUserMessage({
        content: [{ type: 'text', text: `release-rules 告警：${warnings.map(f => `[${f.ruleId}] ${f.message}`).join('；')}` }],
        source: { kind: 'plugin', plugin: 'release-rules' },
      })
      return { ...decision, additionalContexts: [...decision.additionalContexts ?? [], alert] }
    })
  }

  /**
   * Register one rule; returns the disposer so callers can own it with `ctx.effect`.
   * @param rule - the rule to add under its unique id.
   */
  register(rule: ReleaseRule): () => void {
    if (this.rules.has(rule.id)) throw new Error(`rule "${rule.id}" is already registered`)
    this.rules.set(rule.id, rule)
    return () => { this.rules.delete(rule.id) }
  }

  /** Registered rule ids, in registration order. */
  list(): string[] {
    return [...this.rules.keys()]
  }

  /** Every observed deployment outcome, oldest first. */
  history(): readonly ReleaseEvent[] {
    return this.events
  }

  /**
   * Run every rule against one release.
   * @param service - normalized service name.
   * @param version - normalized version.
   */
  evaluate(service: string, version: string): Finding[] {
    const input: RuleInput = { service, version, history: this.events, now: this.config.now() }
    return [...this.rules.values()].flatMap((rule) => {
      const message = rule.evaluate(input)
      return message === undefined ? [] : [{ ruleId: rule.id, severity: rule.severity, message }]
    })
  }

  private keyOf(raw: unknown): { service: string; version: string } | undefined {
    const service = text((raw as Args | undefined)?.service)
    const version = text((raw as Args | undefined)?.version)
    return service === undefined || version === undefined ? undefined : this.config.normalize(service, version)
  }

  private versionsOf(service: string): string[] {
    return [...new Set(this.events.filter(e => e.service === service).map(e => e.version))]
  }
}

/**
 * Wrap one rule as a plugin, so loading registers it and disposing the fiber removes it.
 * @param rule - the rule this plugin owns.
 */
export function rulePlugin(rule: ReleaseRule) {
  return {
    name: `release-rule:${rule.id}`,
    inject: ['releaseRules'],
    apply(ctx: Context) {
      ctx.effect(() => ctx.releaseRules.register(rule))
    },
  }
}

/** 同一版本 24 小时内失败两次，就不许再部署。 */
export const failedTwiceIn24h: ReleaseRule = {
  id: 'same-version-failed-twice',
  severity: 'block',
  evaluate({ service, version, history, now }) {
    const failures = history.filter(e => e.service === service && e.version === version
      && e.outcome === 'failed' && now - e.at < 24 * 3600_000)
    return failures.length >= 2
      ? `${service} ${version} 在 24 小时内已失败 ${failures.length} 次，停止重试`
      : undefined
  },
}

/** 最近一次发布失败，查询时提醒。 */
export const lastReleaseFailed: ReleaseRule = {
  id: 'last-release-failed',
  severity: 'warn',
  evaluate({ service, version, history }) {
    const last = history.filter(e => e.service === service).at(-1)
    return last?.version === version && last.outcome === 'failed'
      ? `${service} 最近一次发布 ${version} 失败`
      : undefined
  },
}
