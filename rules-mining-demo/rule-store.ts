/** Release rules as data (from article 22): revisions with their evidence, an active pointer and deployment history in one storage-domain domain, read by a tool guard. */
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-tools'
// zod 是 dsh-storage-domain 的依赖，没有提升到仓库根，这里借它的安装路径。
import { z } from '../../packages/storage/storage-domain/node_modules/zod/index.js'

declare module '@deepseek-ai/cordis' {
  interface Context { ruleStore: RuleStore }
}

/** A rule is plain data, so a model can propose one and a person can diff it. */
export const ruleSpecSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  kind: z.literal('failed-in-window'),
  threshold: z.number().int().min(1),
  windowHours: z.number().positive(),
}).strict()
export type RuleSpec = z.infer<typeof ruleSpecSchema>

// evidence：候选规则依据的日志事件，`<会话 id>#<seq>`；人工写的版本可以没有。
const revisionSchema = z.object({ spec: ruleSpecSchema, note: z.string(), at: z.number(), evidence: z.array(z.string()).optional() }).strict()
export type Revision = z.infer<typeof revisionSchema>
const activeSchema = z.object({ revision: z.number().int().min(1), note: z.string(), at: z.number() }).strict()
const eventSchema = z.object({
  service: z.string(), version: z.string(), outcome: z.enum(['succeeded', 'failed']), at: z.number(),
}).strict()
export type ReleaseEvent = z.infer<typeof eventSchema>

// 借来的 zod 路径没经过 realpath，TypeScript 把它和 storage-domain 解析到的 zod 当成两份类型；运行时是同一份。
const table = <V>(schema: z.ZodType<V>) => domainTable<string, V>(schema as unknown as Parameters<typeof domainTable<string, V>>[0])

/** Build the domain declaration; `version`, `layout` and `invalidRecords` are knobs the demo probes. */
export function rulesDomain(options: { version?: number; layout?: 'single' | 'per-record'; invalidRecords?: 'backup-and-skip' } = {}) {
  return defineDomain({
    name: 'release_rules',
    version: options.version ?? 1,
    ...options.layout === undefined ? {} : { layout: options.layout },
    ...options.invalidRecords === undefined ? {} : { invalidRecords: options.invalidRecords },
    tables: {
      // `<ruleId>_<n>`：每次修改追加一条，旧版本不改不删。per-record 布局的键只能是 [a-zA-Z0-9_-]。
      revisions: table(revisionSchema),
      // `<ruleId>` -> 当前生效的版本号；没有记录就是停用。
      active: table(activeSchema),
      // 递增序号 -> 一次部署结果。
      events: table(eventSchema),
    },
  })
}
type RulesDomain = Domain<ReturnType<typeof rulesDomain>>

export interface Config {
  deployTool?: string
  now?: () => number
  domain?: ReturnType<typeof rulesDomain>
  /** Skip the zod check before writing a proposed rule (the demo's "trust the model" mode). */
  trustProposals?: boolean
  /** Let rules see outcomes still being written (default true); false reads only what has landed. */
  countPending?: boolean
}

/** Store API over the open domain; every read is synchronous, every write is durable before it resolves. */
export class RuleStore {
  /** Outcomes queued on the write chain but not yet readable from the domain. */
  private readonly pending = new Map<string, ReleaseEvent>()
  private readonly inflight = new Set<Promise<void>>()
  private seq: number
  /** Messages of outcome writes that failed; the tools/result listener cannot surface them anywhere else. */
  readonly writeErrors: string[] = []

  constructor(
    private readonly domain: RulesDomain,
    private readonly now: () => number,
    private readonly trust: boolean,
    private readonly countPending: boolean,
  ) {
    this.seq = Math.max(0, ...[...domain.table('events').keys()].map(Number))
  }

  /** Append a new revision of one rule without activating it; returns its revision number. */
  async propose(raw: unknown, note: string, evidence?: string[]): Promise<number> {
    const spec = this.trust ? raw as RuleSpec : ruleSpecSchema.parse(raw)
    // 取现有最大号加一：按版本数算，坏版本被挪走后会复用旧号，被残留的指针直接启用。
    const revision = Math.max(0, ...this.revisions(spec.id)) + 1
    await this.domain.table('revisions').put(`${spec.id}_${revision}`, { spec, note, at: this.now(), ...evidence === undefined ? {} : { evidence } })
    return revision
  }

  /** Point one rule at an existing revision; activating an older one is the rollback. */
  async activate(ruleId: string, revision: number, note: string): Promise<void> {
    if (this.domain.table('revisions').get(`${ruleId}_${revision}`) === undefined) {
      throw new Error(`rule ${ruleId} has no revision ${revision}`)
    }
    await this.domain.table('active').put(ruleId, { revision, note, at: this.now() })
  }

  /** Stop enforcing one rule; its revisions stay. */
  async deactivate(ruleId: string): Promise<boolean> {
    return this.domain.table('active').delete(ruleId)
  }

  /** Revision numbers of one rule, oldest first. */
  revisions(ruleId: string): number[] {
    return [...this.domain.table('revisions').keys()]
      .filter(key => key.startsWith(`${ruleId}_`))
      .map(key => Number(key.slice(ruleId.length + 1)))
      .sort((a, b) => a - b)
  }

  /** One stored revision, or undefined. */
  revision(ruleId: string, revision: number): Revision | undefined {
    return this.domain.table('revisions').get(`${ruleId}_${revision}`)
  }

  /** Revisions newer than the active one: proposed, not yet enforced. */
  candidates(ruleId: string): number[] {
    const active = this.domain.table('active').get(ruleId)?.revision ?? 0
    return this.revisions(ruleId).filter(n => n > active)
  }

  /** Active rules as `id@revision`, in key order. */
  active(): string[] {
    return [...this.domain.table('active').entries()].map(([id, a]) => `${id}@${a.revision}`).sort()
  }

  /** Deployment outcomes the rules see, oldest first: landed ones, plus in-flight ones when `countPending`. */
  history(): ReleaseEvent[] {
    const all = new Map(this.domain.table('events').entries())
    if (this.countPending) for (const [key, event] of this.pending) all.set(key, event)
    return [...all].sort(([a], [b]) => a.localeCompare(b)).map(([, e]) => e)
  }

  /** Record one outcome; resolves once the write settles, a failure lands in `writeErrors`. */
  async record(event: Omit<ReleaseEvent, 'at'>): Promise<void> {
    // 键在调用时同步分配：写入链上排队的记录还没进内存，按 size 算键会撞。
    const key = String(++this.seq).padStart(6, '0')
    const stored = { ...event, at: this.now() }
    this.pending.set(key, stored)
    const write = this.domain.table('events').put(key, stored)
      .catch((error: unknown) => { this.writeErrors.push(String(error)) })
      .finally(() => { this.pending.delete(key); this.inflight.delete(write) })
    this.inflight.add(write)
    await write
  }

  /** Wait until every recorded outcome has landed (or failed). Call before shutting the host down. */
  async flush(): Promise<void> {
    await Promise.all([...this.inflight])
  }

  /** Every active rule that denies this release, as `[id@rev] message`. */
  violations(service: string, version: string): string[] {
    const now = this.now()
    const history = this.history()
    return [...this.domain.table('active').entries()].flatMap(([id, { revision }]) => {
      const spec = this.domain.table('revisions').get(`${id}_${revision}`)?.spec
      if (spec === undefined) return [`[${id}@${revision}] 规则版本缺失`]
      const failures = history.filter(e => e.service === service && e.version === version
        && e.outcome === 'failed' && now - e.at < spec.windowHours * 3600_000).length
      return failures >= spec.threshold
        ? [`[${id}@${revision}] ${service} ${version} 在 ${spec.windowHours} 小时内已失败 ${failures} 次`]
        : []
    })
  }
}

/** Plugin: open the domain, then serve `ctx.ruleStore`, record deploy outcomes and guard deploys. */
export const name = 'rule-store'
export const inject = ['tools', 'storageDomain']
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const deployTool = config.deployTool ?? 'deploy_release'
  const domain = await ctx.storageDomain.open(config.domain ?? rulesDomain())
  ctx.effect(() => () => domain.close())
  const store = new RuleStore(domain, config.now ?? Date.now, config.trustProposals === true, config.countPending ?? true)

  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== deployTool || result.isError) return undefined
    const value = result.value as { service?: unknown; version?: unknown; outcome?: unknown } | null
    if (typeof value?.service !== 'string' || typeof value.version !== 'string') return undefined
    if (value.outcome !== 'succeeded' && value.outcome !== 'failed') return undefined
    // tools/result 是同步通知，写入只能排进领域的写入链，不能在这里等它落盘。
    void store.record({ service: value.service, version: value.version, outcome: value.outcome })
    return undefined
  })

  ctx.effect(() => ctx.tools.guard((exec) => {
    if (exec.name !== deployTool) return undefined
    const args = exec.arguments as { service?: unknown; version?: unknown } | undefined
    if (typeof args?.service !== 'string' || typeof args.version !== 'string') return undefined
    const reasons = store.violations(args.service, args.version.replace(/^v/i, ''))
    return reasons.length === 0 ? undefined : reasons.join('; ')
  }))

  ctx.provide('ruleStore', store)
}
