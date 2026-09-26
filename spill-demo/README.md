# spill-demo

配套文章《DeepSeek Harness 源码：大工具结果落盘之后，会话日志里只剩预览和一个会过期的路径》（系列第 15 篇）。

五步验证 dsh 的 spill：`fetch_deploy_log` 一次返回 2000 行合成发布日志（122889 字节），超过 `maxInlineBytes: 50000`，
模型和会话日志拿到的都是首尾预览加一个文件路径，预览接缝处没有省略标记，完整内容只在 spill 文件里；模型按提示用 `read`
读回中间的失败记录；fork 子会话继承父会话的路径而不复制文件；文件满 30 天后被 spill-local 激活时的清理删除，日志里的路径读出 `FS_NOT_FOUND`；
最后对照用户附件：spill 文件被改后照常读出，附件被改后以 `ATTACHMENT_CORRUPT` 失败。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone -b dsh-spill https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/spill-demo scratch-plugin/spill-demo
node --import tsx/esm scratch-plugin/spill-demo/spill-demo.ts
```

模型是脚本里写死回复的假适配器，不需要 API key，也不调用真实模型。spill 策略的上限与 base bundle 相同，
spill 根目录、会话日志和附件目录都放在系统临时目录下的一个目录里，退出时删除。与 base bundle 的差异：
文件系统用 `dsh-fs-local` 而不是 `dsh-fs-sandbox`；“31 天”靠修改文件修改时间模拟，“重启”是在同一进程里销毁并重建 Context。
输出里 spill 文件名的随机前缀显示为 `<rand>`。脚本每一步都带断言，行为与文章不符时以非零退出码结束。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
