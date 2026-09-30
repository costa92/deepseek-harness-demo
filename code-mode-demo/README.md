# code-mode-demo

配套文章《DeepSeek Harness 源码：Code Mode 照样过守卫，拒绝只有程序看得到》（系列第 25 篇）。

把 `dsh-tools` 的 `mode` 设成 `ptc`，挂上 PTC 进程运行时 `dsh-ptc-runtime-node`，模型只能调用 `run_code`，部署都在它写的程序里以子调用发生。脚本逐项检查规则引擎、会话日志和审批在这种模式下的表现。
- `release-rules.ts`：第 21 篇的发布规则引擎，代码不变；本篇挂载时配了去掉 `v` 前缀的规范化。
- `log-miner.ts`：第 23 篇的 `readDeploys`，去掉了异常分组部分，用来说明它读不到程序里的部署。
- `code-mode-demo.ts`：驱动脚本。验证模型只拿到 `run_code`；子调用照样过守卫，但拒绝以 `ToolCallError` 到达程序、可被吞掉；子调用记在 `tool/ptc-dispatch` 里、没有 `meta`；`deny` 带的错误码只进日志；工具声明 `isConcurrencySafe` 时守卫拦不住并发部署；子调用审批的 callId 要在 `tool/ptc-dispatch-start` 里查，等审批算进程序超时；程序抛错时前面的部署已生效。另外对照原生模式：`presentationMeta` 只在原生部署时被调用；一条消息里 3 个调用声明 `isConcurrencySafe` 时守卫同样拦不住；不传 `timeoutMs` 时程序按默认 120 秒超时，审批人 125 秒后才批准，部署不执行。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/code-mode-demo scratch-plugin/code-mode-demo
node --import tsx/esm scratch-plugin/code-mode-demo/code-mode-demo.ts
```

文章首次发布时的代码保留在 `dsh-code-mode` 分支；2026-09-30 补测后，`master` 上的本目录新增了步骤与断言，与该分支不同。

模型和审批人都是脚本化的：模型每一步写什么程序是预先写好的，不需要 API key，也不调用真实模型；审批人按设定的延迟批准。发布平台是合成的，时钟固定。
程序在全新的 Node 子进程里执行，受本地沙箱（`workspace-write`）约束。会话日志写在系统临时目录，脚本退出时删除。本机为 Linux，其他平台未验证。
脚本每一步都带断言，行为与文章不符时以非零退出码结束，一次运行约 2 分钟，大部分时间在等第 6 步的默认 120 秒程序超时。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
