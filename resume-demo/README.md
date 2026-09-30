# resume-demo

配套文章《DeepSeek Harness 源码：kill -9 后能续跑，工具调用记录靠检查点插件》（系列第 12 篇）。

十三步验证 dsh 的崩溃恢复与 fork：子进程跑一次查询，在 `lookup_release` 执行途中被 `SIGKILL`；
旧进程还活着时恢复被写锁拒绝；手工追加半行 JSON 模拟撕裂尾部；换进程恢复后补上 `tool/result`
（`TOOL_OUTCOME_UNKNOWN`）、`step/end`、`turn/end(interrupted)` 三条收尾事件；下一轮模型收到合成的
错误结果；对照挂与不挂 `dsh-session-checkpoint-policy` 时，一个有副作用的工具执行后进程被杀，日志里
还剩什么；从中断处 fork 出一个子会话。
另外验证：日志停在助手消息、还没有 `tool/call` 时补 `TOOL_NOT_STARTED`；`tool/call` 先于守卫落盘，守卫卡住时 kill -9；
等审批时崩溃；追加在 200ms 批量写入之前只在内存；不挂检查点策略、模型 50ms 时的对照；模型流式输出中 kill -9，
进行中的请求内没有检查点；zstd 撕裂的末帧在恢复时解码、重编码并重写。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/resume-demo scratch-plugin/resume-demo
node --import tsx/esm scratch-plugin/resume-demo/resume-demo.ts
```

文章首次发布时的代码保留在 `dsh-resume` 分支；2026-09-30 补测后，`master` 上的本目录新增了步骤与断言，与该分支不同。

模型是脚本里写死回复的假适配器，不需要 API key，也不调用真实模型；子进程里的模型每次请求人为延迟
300ms。脚本会启动子进程并用 `SIGKILL` 结束它们，会话日志写在系统临时目录下，退出时删除。脚本每一步
都带断言，行为与文章不符时以非零退出码结束。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`，Linux。
