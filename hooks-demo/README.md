# hooks-demo

配套文章《DeepSeek Harness 源码：Claude Code 的 hooks 搬进 dsh，7 种写法拦不住部署》（系列第 28 篇）。

用 `dsh-hooks-claude-code` 给发布值班 agent 挂一份 Claude Code 格式的 hooks.json，再挂上第 21 篇的规则引擎。
- `release-hook.mjs`：一个 command hook 脚本，按命令行参数切换行为（退出码 2 拦截、各种错写、ask / allow、部署后检查、Stop 强制继续等）；把收到的 stdin、工作目录和能否读到令牌记进会话工作区里的账本。
- `release-rules.ts`：第 21 篇的发布规则引擎，与第 27 篇相同。
- `hooks-demo.ts`：驱动脚本。验证退出码 2 拦下部署、hook 收到的 stdin 与环境、会话日志里的 `hook/*` 事件；7 种写法没拦住部署；hook 的 ask / allow 绕不过守卫，但 ask 会跳过后注册的 pre-execute 插件；PostToolUse 拦截让规则引擎漏记失败；Stop 强制继续没有上限，`stop_hook_active` 永远为 false。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/hooks-demo scratch-plugin/hooks-demo
node --import tsx/esm scratch-plugin/hooks-demo/hooks-demo.ts
```

模型和审批人都是脚本化的，不需要 API key，也不调用真实模型。发布平台是本地注册的合成工具，时钟固定。hook 由 dsh 的 bash 执行器以 `node` 启动，需要 `node` 在 `PATH` 里；hooks.json 和账本写在系统临时目录，脚本退出时删除。脚本进程会设置一个假的 `RELEASE_API_TOKEN` 环境变量，用来观察它是否传给 hook。本机为 Linux，其他平台未验证。
脚本每一步都带断言，行为与文章不符时以非零退出码结束，一次运行约 7 秒。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
