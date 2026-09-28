# workflow-demo

配套文章《DeepSeek Harness 源码：同一次巡检写成 workflow 和 Ralph，失败变成 null，完成只凭一句话》（系列第 20 篇）。

用“巡检 3 个服务最近一次发布”这个任务，挂载真实的 `dsh-workflow-ptc`、`dsh-tool-workflow`、`dsh-tool-ralph`、`dsh-ptc-runtime-node` 与本地沙箱，对比两种编排：
模型写的 workflow 脚本里一个子 agent 失败只留下 `null`，run 仍报 completed；给 `agent()` 写错一个选项，整个 run 失败；
Ralph 固定循环每轮一个全新 worker、只交接上一轮报告，证据里一句“都查过了”就算完成，出错、报告不合格、超出上限时都报错；
子 agent 在 workflow 里再开 workflow，委派深度一路到第 4 层，越过了 `subagent` 工具的一层上限。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/workflow-demo scratch-plugin/workflow-demo
node --import tsx/esm scratch-plugin/workflow-demo/workflow-demo.ts
```

文章发布时的代码保留在 `dsh-workflow` 分支，示例源码与 `master` 上的本目录相同，README 的运行方式有更新。

模型是按会话分派动作的假适配器，不需要 API key，也不调用真实模型；Ralph worker 的报告和发布数据都是预先写好的合成数据。
workflow 脚本真的在 PTC 起的 Node 进程里执行，沙箱策略为 `workspace-write`，工作区是系统临时目录，进程退出时删除。本机为 Linux，其他平台未验证。
脚本每一步都带断言，行为与文章不符时以非零退出码结束。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
