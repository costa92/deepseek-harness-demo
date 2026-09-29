# guard-demo

配套文章《DeepSeek Harness 源码：部署超时后模型重试，平台收到三次部署》（系列第 33 篇）。

dsh 基础组合默认挂了两个 guard 插件：`dsh-tool-call-timeout-policy` 给声明了 `timeoutMs` 的工具设协作式超时，`dsh-repeat-tool-reminder` 在模型用相同参数反复调同一个工具时提醒它。脚本在一个进程里挂上这两个插件（提醒阈值用发行版的 `[3, 5, 8]`），用脚本化模型驱动几个内存会话，工具背后是一个合成的发布平台：收到部署请求就开始，2.5 秒后上线，取消等待不会撤回部署。

- `guard-demo.ts`：分 5 节验证：
  - 转发 `exec.signal` 的部署工具 1 秒超时，模型收到超时错误，平台照样上线；
  - 声明了超时却不理 `signal` 的工具要等满 2.5 秒，部署成功了，模型收到的仍是超时错误；没声明超时的慢工具不受影响；
  - 用同样的参数连调 3 次部署、每次都超时，平台收到 3 次部署，提醒在第 3 次之后才出现；
  - 同样的参数查 9 次状态，提醒出现在第 3、5、8 次之后，调用一次也没被拦；
  - 交替两组参数、参数里带递增计数、中间插一条人类消息，这三种循环都不触发提醒。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/guard-demo scratch-plugin/guard-demo
node --import tsx/esm scratch-plugin/guard-demo/guard-demo.ts
```

模型是脚本化的，不需要 API key，也不调用真实模型。发布平台是合成的，上线用 2.5 秒的定时器模拟，会话只在内存。本机为 Linux，其他平台未验证。
脚本每一步都带断言，行为与文章不符时以非零退出码结束，一次运行约 14 秒，大部分时间在等定时器。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
