/** Read deploy outcomes back out of persisted session logs, and turn repeated failures into anomalies with evidence refs. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type { RuleSpec } from './rule-store.ts'

/** One deploy call as the log remembers it. */
export interface DeployRecord {
  /** `<session id>#<seq>` of the tool/result event. */
  readonly ref: string
  readonly session: string
  /** Raw argument string of the matching tool/call event, as the model sent it. */
  readonly rawArguments: string
  /** executed: the platform ran it; denied: a rule rejected it; error: anything else that failed. */
  readonly kind: 'executed' | 'denied' | 'error'
  readonly text: string
  readonly service?: string
  readonly version?: string
  readonly outcome?: string
  readonly at?: number
  /** Keys of the tool/result event data, to show what the log actually keeps. */
  readonly dataKeys: string[]
}

type ToolResultData = SessionEvent<'tool/result'>['data']
type Meta = { service?: unknown; version?: unknown; outcome?: unknown; at?: unknown }

/**
 * Collect every call of one tool across all sessions the session-query service can see.
 * @param ctx - context with `ctx.sessionQuery` mounted.
 * @param tool - tool name to collect.
 */
export async function readDeploys(ctx: Context, tool = 'deploy_release'): Promise<DeployRecord[]> {
  const records: DeployRecord[] = []
  const sessions = (await ctx.sessionQuery.listSessions()).map(r => r.header.id).sort()
  for (const session of sessions) {
    const { events } = await ctx.sessionQuery.readSession(session)
    const calls = new Map<string, { name: string; arguments: string }>()
    for (const event of events) {
      if (event.type === 'tool/call') {
        calls.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments })
        continue
      }
      if (event.type !== 'tool/result') continue
      const data: ToolResultData = event.data
      const block = data.message.content.find(b => b.type === 'tool-result')
      const call = block === undefined ? undefined : calls.get(block.toolCallId)
      if (block === undefined || call?.name !== tool) continue
      const text = block.content.map(c => c.type === 'text' ? c.text : '').join('')
      // 结构化字段只能从 meta 拿：日志里存的是渲染给模型的文字，不是工具返回的值。
      const meta = (data.meta ?? {}) as Meta
      const kind = block.isError !== true ? 'executed' : /^Error: \[[a-z0-9-]+@\d+\]/.test(text) ? 'denied' : 'error'
      records.push({
        ref: `${session}#${event.seq}`, session, rawArguments: call.arguments, kind, text,
        ...typeof meta.service === 'string' ? { service: meta.service } : {},
        ...typeof meta.version === 'string' ? { version: meta.version } : {},
        ...typeof meta.outcome === 'string' ? { outcome: meta.outcome } : {},
        ...typeof meta.at === 'number' ? { at: meta.at } : {},
        dataKeys: Object.keys(data).sort(),
      })
    }
  }
  return records
}

/** A release that kept failing although a rule was active. */
export interface Anomaly {
  readonly service: string
  readonly version: string
  readonly failures: number
  readonly denials: number
  readonly sessions: number
  readonly spanHours: number
  /** Refs of the executed-and-failed calls. */
  readonly evidence: string[]
}

/**
 * Flag releases that failed more often than the active rule allows: the rule fired, yet the version kept being deployed.
 * @param records - deploy records from {@link readDeploys}.
 * @param active - the active rule spec the failures slipped past.
 */
export function findAnomalies(records: readonly DeployRecord[], active: RuleSpec): Anomaly[] {
  const groups = new Map<string, DeployRecord[]>()
  for (const r of records) {
    if (r.kind !== 'executed' || r.outcome !== 'failed' || r.service === undefined || r.version === undefined) continue
    const key = `${r.service} ${r.version}`
    groups.set(key, [...groups.get(key) ?? [], r])
  }
  return [...groups].flatMap(([key, failed]) => {
    const [service = '', version = ''] = key.split(' ')
    const times = failed.map(r => r.at ?? 0)
    const spanHours = (Math.max(...times) - Math.min(...times)) / 3600_000
    if (failed.length <= active.threshold) return []
    const denials = records.filter(r => r.kind === 'denied' && r.text.includes(` ${service} ${version} `)).length
    return [{
      service, version, failures: failed.length, denials,
      sessions: new Set(failed.map(r => r.session)).size, spanHours, evidence: failed.map(r => r.ref),
    }]
  })
}
