# rules-review-demo

配套文章《DeepSeek Harness 源码：候选规则先回放评测再经审批启用，审批请求里不带调用参数》（系列第 24 篇）。

把会话日志里读回的部署当作固定数据集，回放评测候选规则；启用规则的工具在 `tools/pre-execute` 里先算评测、写评测表，再返回 `ask`，交给 `dsh-user-approval` 的应答者决定；最后用版本表、评测表和会话日志里的审批事件拼出规则谱系。
- `rule-store.ts`：沿用第 23 篇的规则存储，加了评测表（键为 `<会话 id>#<callId>`）；其余配置项本篇没有用到。
- `log-miner.ts`：沿用第 23 篇，从会话日志读回部署记录。
- `evaluate.ts`：回放函数 `replay()`、数据集标识 `datasetId()`，以及注册 `activate_rule` 工具并返回 `ask` 的插件。
- `rules-review-demo.ts`：驱动脚本。验证三个版本的回放结果、应答者收到的字段（不含调用参数，按 `callId` 回日志可查到）、被拒时模型收到的文字、谱系拼接、生效后的守卫，以及没有 agent 或卸掉审批服务时的拒绝理由。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone -b dsh-rules-review https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/rules-review-demo scratch-plugin/rules-review-demo
node --import tsx/esm scratch-plugin/rules-review-demo/rules-review-demo.ts
```

本目录已合并到仓库的 `master` 分支：上面的命令去掉 `-b dsh-rules-review` 也能取到同样的代码。原分支保留，与文章里的链接对应。

模型和审批人都是脚本化的：模型按轮次执行预设动作，不需要 API key，也不调用真实模型；审批人按 `reason` 里有没有误拦决定。发布平台和时钟是合成的，“三天”是在同一进程里拨时钟。
会话日志和规则数据写在系统临时目录，脚本退出时删除。本机为 Linux，其他平台未验证。
zod 是 `dsh-storage-domain` 的依赖，没有装在仓库根，`rule-store.ts` 按 pnpm 的安装路径 `packages/storage/storage-domain/node_modules/zod` 引入。
脚本每一步都带断言，行为与文章不符时以非零退出码结束。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
