# session-demo

配套文章《DeepSeek Harness 源码：模型看到的 5 条消息，是从 16 条日志里算出来的》（系列第 11 篇）。

六步验证 dsh 的会话日志：一次带 `lookup_release` 调用的查询经真实 agent 循环写下 16 条事件，
模型历史是其中 5 条消息事件的派生结果；只解析 JSONL 文件就能还原整次查询；重启后再问一轮，
旧字节保持不变、seq 连续；重启前后派生历史相同，投影状态从日志重新折叠；日志里出现不认识且
未标 `ignorable` 的事件时，读方拒绝解读整份日志。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone -b dsh-session https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/session-demo scratch-plugin/session-demo
node --import tsx/esm scratch-plugin/session-demo/session-demo.ts
```

模型是脚本里写死回复的假适配器，不需要 API key，也不调用真实模型。会话日志写在系统临时目录下，
持久化使用 `compression: 'none'` 以便直接阅读，退出时删除。脚本每一步都带断言，行为与文章不符时
以非零退出码结束。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
