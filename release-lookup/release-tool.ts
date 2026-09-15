/** Read-only release-record lookup for the article's synthetic dataset. */
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool, validateJsonSchemaValue, valueSchemaSpecToJsonSchema, type InferValue } from '@deepseek-ai/dsh-tools'

export const name = 'release-lookup'
export const inject = ['tools']

/** Operator-selected file; model arguments never select filesystem paths. */
export interface Config { recordsPath: string }
export const Config: Schema<Config> = Schema.object({ recordsPath: Schema.string().required() })

const recordSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    service: { type: 'string', required: true },
    environment: { type: 'string', enum: ['staging', 'production'], required: true },
    version: { type: 'string', required: true },
    status: { type: 'string', enum: ['succeeded', 'failed'], required: true },
    deployedAt: { type: 'string', required: true },
  },
} as const
const recordsSchema = { type: 'array', items: recordSchema } as const

/** Register a lookup that validates file data on every call.
 * @param ctx - Cordis context with the tools service.
 * @param config - Absolute path to a small trusted JSON dataset.
 */
export function apply(ctx: Context, config: Config) {
  if (!isAbsolute(config.recordsPath)) throw new Error('recordsPath must be absolute')
  ctx.tools.register(defineTool({
    name: 'lookup_release',
    description: 'Query synthetic release history by service and environment. Returns newest records first. A failed release is not a deployed version; history cannot prove the current live version.',
    parameters: {
      service: { type: 'string', required: true, description: 'Exact service name, e.g. payment-api' },
      environment: { type: 'string', enum: ['staging', 'production'], required: true },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['found', 'not_found'], required: true },
          records: { ...recordsSchema, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const service = args.service.trim()
      if (!service) throw new Error('service must not be blank')
      const raw: unknown = JSON.parse(await readFile(config.recordsPath, { encoding: 'utf8', signal: exec.signal }))
      validateJsonSchemaValue(valueSchemaSpecToJsonSchema(recordsSchema), raw)
      const records = raw as InferValue<typeof recordsSchema>
      for (const record of records) {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(record.deployedAt) || !Number.isFinite(Date.parse(record.deployedAt)) || new Date(record.deployedAt).toISOString() !== record.deployedAt.replace('Z', '.000Z')) {
          throw new Error(`Invalid deployedAt in record ${record.id}`)
        }
      }
      const matches = records
        .filter(record => record.service === service && record.environment === args.environment)
        .sort((a, b) => Date.parse(b.deployedAt) - Date.parse(a.deployedAt))
      return { status: matches.length ? 'found' as const : 'not_found' as const, records: matches }
    },
  }))
}
