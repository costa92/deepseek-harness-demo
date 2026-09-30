# session-demo

配套文章《DeepSeek Harness 源码：模型看到的 5 条消息由 16 条日志算出》（系列第 11 篇）。

十一步验证 dsh 的会话日志：一次带 `lookup_release` 调用的查询经真实 agent 循环写下 16 条事件，
模型历史是其中 5 条消息事件的派生结果；只解析 JSONL 文件就能还原整次查询；重启后再问一轮，
旧字节保持不变、seq 连续；重启前后派生历史相同，投影状态从日志重新折叠；日志里出现不认识且
未标 `ignorable` 的事件时，读方拒绝解读整份日志。另外验证 `request/header` 只在开始、变化和新系列时追加；
切沙箱模式在同一文件里多一行；仓库外插件追加的自定义事件写得进去、重启后读不出；默认 zstd 压缩下撕裂的末帧只丢解不出的部分；
每次追加先写入再 fsync 才算数（用 strace 观察）。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/session-demo scratch-plugin/session-demo
node --import tsx/esm scratch-plugin/session-demo/session-demo.ts
```

文章首次发布时的代码保留在 `dsh-session` 分支；2026-09-30 补测后，`master` 上的本目录新增了步骤与断言，与该分支不同。

模型是脚本里写死回复的假适配器，不需要 API key，也不调用真实模型。会话日志写在系统临时目录下，
持久化使用 `compression: 'none'` 以便直接阅读，退出时删除。脚本每一步都带断言，行为与文章不符时
以非零退出码结束。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
