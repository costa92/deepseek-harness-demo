/** Mounted inside the dsh child by bridge.cordis.patch.yml: answers approval requests from files the out-of-process client writes. */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-user-approval'

export const name = 'approval-bridge'
export const inject = ['approval']

export interface Config { dir: string; timeoutMs?: number }
export const Config: z<Config> = z.object({
  dir: z.string().required(),
  timeoutMs: z.number().default(5000),
})

/** Register one approval/request answerer that waits for `<sessionId>.<callId>.answer` in the shared directory.
 * @param ctx - Cordis context with the approval service.
 * @param config - Shared directory and how long to wait for the client.
 */
export function apply(ctx: Context, config: Config) {
  ctx.on('approval/request', async (request, next) => {
    // 没有 callId 的请求（例如沙箱提权）交给后面的应答者。
    if (request.callId === undefined) return next()
    const file = join(config.dir, `${request.agent.session.id}.${request.callId}.answer`)
    for (let waited = 0; waited < (config.timeoutMs ?? 5000); waited += 20) {
      if (request.signal?.aborted === true) return 'cancelled'
      if (existsSync(file)) {
        const answer = readFileSync(file, 'utf8').trim()
        // 读完就删：callId 可能重复（例如换进程后模型从 call-1 重新编号），旧答案不能留给下一次。
        rmSync(file)
        return answer === 'allow' ? 'allowed-once' : 'rejected'
      }
      await sleep(20)
    }
    // 客户端没回话就当审批通道不可用，不让这一轮一直挂着；踩着超时到达的答案一并作废。
    rmSync(file, { force: true })
    return 'unavailable'
  })
}
