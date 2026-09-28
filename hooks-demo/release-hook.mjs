/** One Claude Code command hook with several behaviors, picked by argv: reads the stdin payload, records it, then answers the way that mode says. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [mode] = process.argv.slice(2)
const payload = JSON.parse(readFileSync(0, 'utf8'))
// 账本放在项目目录（桥接把它设成会话工作区），demo 从这里核对 hook 收到了什么。
const dir = process.env.CLAUDE_PROJECT_DIR
appendFileSync(join(dir, 'hook-ledger.jsonl'), `${JSON.stringify({
  mode,
  payload,
  cwd: process.cwd(),
  token: process.env.RELEASE_API_TOKEN === undefined ? 'absent' : 'present',
})}\n`)

const version = String(payload.tool_input?.version)
const json = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const pre = fields => json({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } })

switch (mode) {
  // 冻结窗口：按 Claude Code 文档的写法，退出码 2 加 stderr 拦下。
  case 'freeze':
    process.stderr.write(`发布冻结中，${version} 等窗口结束再部署\n`)
    process.exit(2)
    break
  // 常见的错写：以为非零退出码都能拦。
  case 'exit1':
    process.stderr.write('发布冻结中\n')
    process.exit(1)
    break
  // JSON 里写明 deny，退出码却是 1。
  case 'deny-exit1':
    pre({ permissionDecision: 'deny', permissionDecisionReason: '发布冻结中' })
    process.exit(1)
    break
  // 把 permissionDecision 的取值写到了顶层 decision 上。
  case 'top-deny':
    json({ decision: 'deny', reason: '发布冻结中' })
    break
  // 顶层 decision 的合法取值只有 approve / block。
  case 'top-block':
    json({ decision: 'block', reason: '发布冻结中' })
    break
  // hookSpecificOutput 漏了 hookEventName。
  case 'no-event-name':
    json({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: '发布冻结中' } })
    break
  // 检查脚本卡住，超过 hooks.json 里配的 timeout。
  case 'slow':
    setTimeout(() => { process.stderr.write('发布冻结中\n'); process.exit(2) }, 5000)
    break
  case 'ask':
    pre({ permissionDecision: 'ask', permissionDecisionReason: `hook 要求人工确认 ${version}` })
    break
  case 'allow':
    pre({ permissionDecision: 'allow' })
    break
  // 部署后检查：平台回报 failed 就拦下结果，让模型别再重试。
  case 'post-check':
    if (/failed/.test(String(payload.tool_response))) {
      json({ decision: 'block', reason: `${version} 部署失败，先查原因再重试` })
    } else {
      json({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `${version} 已上线，记得 10 分钟后看错误率` } })
    }
    break
  // 收尾前要求先做冒烟检查；自己用标记文件计数，两次后放行。
  case 'stop-smoke': {
    const marker = join(dir, 'stop-count')
    const count = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : 0
    writeFileSync(marker, String(count + 1))
    if (count < 2) json({ decision: 'block', reason: `还没跑冒烟检查（第 ${count + 1} 次拦下）` })
    break
  }
  // Claude Code 文档的防循环写法：已经因 Stop hook 继续过一次，就放行。
  case 'stop-cc':
    if (payload.stop_hook_active !== true) json({ decision: 'block', reason: '收尾前先跑冒烟检查' })
    break
  // 什么都不拦，只要求整个运行停下。
  case 'halt':
    json({ continue: false, stopReason: '值班交接，停止一切操作' })
    break
  default:
    break
}
