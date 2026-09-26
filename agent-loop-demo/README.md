# agent-loop-demo

配套文章《DeepSeek Harness 源码：一轮“查询 → 回答”走了两步，模型连调 25 次工具也没人拦》（系列第 16 篇）。

五步追踪 dsh 的 Agent Loop：给主要钩子挂上记录用的监听器，按顺序打印一次“查询 → 回答”经过的每个钩子和每条会话日志事件；
核对第二次模型请求的消息与 `session.deriveMessages()` 一致且已冻结；工具执行中分别 `steer` 和 `followup`，看它们落在哪一轮哪一步；
让模型连续调 25 次工具，确认循环没有步数上限、`agent/turn-stopping` 只在最后触发一次；最后对比三种停法：
`agent/pre-step` 拒绝（被拒绝的步骤领走的 steer 消息会丢失）、在钩子里 `agent.cancel()`、工具里 `exec.concludeTurn()`。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone -b dsh-agent-loop https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/agent-loop-demo scratch-plugin/agent-loop-demo
node --import tsx/esm scratch-plugin/agent-loop-demo/agent-loop-demo.ts
```

模型是脚本里写死回复的假适配器，不需要 API key，也不调用真实模型；没有挂持久化，会话只在内存里，不写任何文件。
发布数据是合成的。脚本每一步都带断言，行为与文章不符时以非零退出码结束。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
