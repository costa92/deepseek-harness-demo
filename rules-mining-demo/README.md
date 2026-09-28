# rules-mining-demo

配套文章《DeepSeek Harness 源码：从会话日志里挖候选规则，被规则拒绝和普通报错在日志里字段相同》（系列第 23 篇）。

三天值班会话写进 JSONL 会话日志后，换一个宿主用 `dsh-session-query-sqlite` 读回所有 `deploy_release` 调用，找出生效规则没管住的失败发布，再让评审会话里的模型据此提一条带证据的候选规则。
- `rule-store.ts`：沿用第 22 篇的规则存储，版本记录加了 `evidence` 字段和 `candidates()`；其余配置项本篇没有用到。
- `log-miner.ts`：按 `callId` / `toolCallId` 配对 `tool/call` 与 `tool/result`，结构化字段取自工具 `presentationMeta` 写进日志的 `meta`；被拒与其他错误只能按文字区分。
- `rules-mining-demo.ts`：驱动脚本。验证日志只存渲染文字、被拒和普通报错字段相同、`tool/call` 参数是模型原话；`propose_rule` 校验规则数据并回日志核对证据编号；候选存成新版本但不生效。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/rules-mining-demo scratch-plugin/rules-mining-demo
node --import tsx/esm scratch-plugin/rules-mining-demo/rules-mining-demo.ts
```

文章发布时的代码保留在 `dsh-rules-mining` 分支，示例源码与 `master` 上的本目录相同，README 的运行方式有更新。

模型是按轮次执行预设动作的假适配器，不需要 API key，也不调用真实模型；发布平台和时钟是合成的，“三天”是在同一进程里拨时钟。
会话日志和规则数据写在系统临时目录，脚本退出时删除。本机为 Linux，其他平台未验证。
zod 是 `dsh-storage-domain` 的依赖，没有装在仓库根，`rule-store.ts` 按 pnpm 的安装路径 `packages/storage/storage-domain/node_modules/zod` 引入。
脚本每一步都带断言，行为与文章不符时以非零退出码结束。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
