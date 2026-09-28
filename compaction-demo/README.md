# compaction-demo

配套文章《DeepSeek Harness 源码：40 条发布记录剪完之后，模型只看得到 6 次失败里的 3 次》（系列第 13 篇）。

五步验证 dsh 的上下文压缩：`lookup_release` 每次返回 40 条合成发布记录，连续查 7 个服务把上下文撑满。
压力超过阈值时先剪掉工具结果的中间（中间的失败记录对模型不可见）；剪完仍超阈值时把较早的一段写成摘要，
替换进模型历史；服务商返回 `CONTEXT_WINDOW_EXCEEDED` 时压缩一次再重试，连续超限则本轮以错误结束；
日志文件里原始记录一条不少，离线折叠出的历史与运行中一致；最后对照 token 估算（4 字符 1 token）与
DeepSeek 文档给出的中英文换算比例。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone -b dsh-compaction https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/compaction-demo scratch-plugin/compaction-demo
node --import tsx/esm scratch-plugin/compaction-demo/compaction-demo.ts
```

模型是脚本里写死回复的假适配器，不需要 API key，也不调用真实模型：上下文窗口人为设为 2000 token，
摘要是固定文本，超限错误按脚本返回。剪枝阈值按比例缩小（超过 1200 字符才剪，保留头 600、尾 200）。
会话日志写在系统临时目录下，退出时删除。脚本每一步都带断言，行为与文章不符时以非零退出码结束。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
