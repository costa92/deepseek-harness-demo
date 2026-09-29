# deepseek-harness-demo

DeepSeek Harness 系列文章的配套示例代码。每篇文章一个目录，互不依赖；目录里的 README 写明对应文章、验证内容和运行方式。

## 使用方式

示例依赖 DeepSeek Harness 源码工作区，请先准备已安装依赖并完成构建的 DeepSeek Harness 仓库。每个示例目录的 README 都给出从头到尾的完整命令，在 **DeepSeek Harness 仓库根目录** 照做即可：克隆本仓库，把示例目录复制到 `scratch-plugin/` 下（示例按这个目录层级解析依赖），再运行。源码系列（第 4–30 篇）的示例都是这个形式，例如：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/mcp-client-demo scratch-plugin/mcp-client-demo
node --import tsx/esm scratch-plugin/mcp-client-demo/mcp-client-demo.ts
```

已经克隆过本仓库时，跳过 `mkdir` 和 `git clone` 两行，从 `cp -R` 开始；`scratch-plugin/` 下已有同名示例目录时先删除它，否则 `cp -R` 会复制成嵌套的子目录。

源码系列的示例都不需要 API key，也不调用真实模型：用到模型、审批人和发布平台的地方都是脚本化或合成的。脚本带断言，行为与文章不符时以非零退出码结束。验证环境均为 DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。

## 目录

`master` 汇总了全部示例，文章里的代码链接和运行命令都固定到 `master` 上的提交。文章发布时每个示例放在单独的分支上，这些分支保留不动，示例源码与 `master` 上对应目录相同，`master` 上的 README 更新了运行方式。

### 实战

| 篇 | 目录 | 内容 | 原分支 |
|---|---|---|---|
| 3 | [`release-lookup`](release-lookup/) | 给 Agent 写一个发布记录查询工具 `lookup_release` | `master` |

`release-lookup` 需要本机模型凭据，运行方式见下文。

### 源码系列

| 篇 | 目录 | 配套文章《DeepSeek Harness 源码：…》 | 原分支 |
|---|---|---|---|
| 4 | [`effect-demo`](effect-demo/) | 插件卸载后，它注册的东西去哪了 | `cordis-effect` |
| 5 | [`service-demo`](service-demo/) | 换掉数据源，插件一行都不用改 | `cordis-service` |
| 6 | [`events-demo`](events-demo/) | 五种事件分发，waterfall 不是流水线 | `cordis-events` |
| 7 | [`tree-demo`](tree-demo/) | 一个插件挂两份配置，改配置就是重启 | `cordis-tree` |
| 8 | [`tools-demo`](tools-demo/) | ctx.fs 能整个换掉，ctx.tools 为什么不行 | `dsh-tools` |
| 9 | [`pipeline-demo`](pipeline-demo/) | 一个前置监听器就能放行全量查询，所以 dsh 另设了守卫 | `dsh-pipeline` |
| 10 | [`sandbox-demo`](sandbox-demo/) | 沙箱拦住了越界写入，却在中文系统上认不出自己的拒绝 | `dsh-sandbox` |
| 11 | [`session-demo`](session-demo/) | 模型看到的 5 条消息，是从 16 条日志里算出来的 | `dsh-session` |
| 12 | [`resume-demo`](resume-demo/) | kill -9 之后会话能接着跑，但记不记得工具已经开始，要看一个没有配置项的插件 | `dsh-resume` |
| 13 | [`compaction-demo`](compaction-demo/) | 40 条发布记录剪完之后，模型只看得到 6 次失败里的 3 次 | `dsh-compaction` |
| 14 | [`session-query-demo`](session-query-demo/) | 跨会话搜得出 demo-003，却搜不到“回滚” | `dsh-session-query` |
| 15 | [`spill-demo`](spill-demo/) | 大工具结果落盘之后，会话日志里只剩预览和一个会过期的路径 | `dsh-spill` |
| 16 | [`agent-loop-demo`](agent-loop-demo/) | 一轮“查询 → 回答”走了两步，模型连调 25 次工具也没人拦 | `dsh-agent-loop` |
| 17 | [`preset-demo`](preset-demo/) | 给发布值班 preset 加上工具白名单，切换进来的会话照样看到宿主工具 | `dsh-preset` |
| 18 | [`goal-demo`](goal-demo/) | 巡检目标自动续跑了 5 轮，只查 2 个服务就说完成也照样通过 | `dsh-goal` |
| 19 | [`subagent-demo`](subagent-demo/) | 每个服务派一个子 agent，父 agent 自己拉黑的回滚工具子 agent 照样能调 | `dsh-subagent` |
| 20 | [`workflow-demo`](workflow-demo/) | 同一次巡检写成 workflow 和 Ralph，失败变成 null，完成只凭一句话 | `dsh-workflow` |
| 21 | [`rules-demo`](rules-demo/) | 在工具流水线上搭发布规则引擎，守卫只看到原始参数，版本写成 v2.3 就绕过了规则 | `dsh-rules` |
| 22 | [`rules-store-demo`](rules-store-demo/) | 规则存进 storage-domain，刚写的记录读不到，一条坏记录让守卫消失 | `dsh-rules-store` |
| 23 | [`rules-mining-demo`](rules-mining-demo/) | 从会话日志里挖候选规则，被规则拒绝和普通报错在日志里字段相同 | `dsh-rules-mining` |
| 24 | [`rules-review-demo`](rules-review-demo/) | 候选规则先回放评测再经审批启用，审批请求里不带调用参数 | `dsh-rules-review` |
| 25 | [`code-mode-demo`](code-mode-demo/) | Code Mode 下子调用照样过守卫，但拒绝只有程序看得到 | `dsh-code-mode` |
| 26 | [`llm-retry-demo`](llm-retry-demo/) | 模型请求重试的预算按步算，normal 模式下 Retry-After 太长就不重试 | `dsh-llm-retry` |
| 27 | [`mcp-client-demo`](mcp-client-demo/) | 发布平台改成 MCP 服务器后，规则引擎认不出部署，dsh 也不校验参数 | `dsh-mcp-client` |
| 28 | [`hooks-demo`](hooks-demo/) | Claude Code 的 hooks 搬进 dsh，7 种写法拦不住部署 | `dsh-hooks` |
| 29 | [`jobs-schedule-demo`](jobs-schedule-demo/) | 后台冒烟检查随重启消失，提醒会等到会话恢复 | `dsh-jobs-schedule` |
| 30 | [`headless-sdk-demo`](headless-sdk-demo/) | 部署被拒退出码仍是 0，SDK 客户端对审批请求只能看不能答 | `dsh-headless-sdk` |
| 31 | [`webhook-demo`](webhook-demo/) | webhook 同一投递送两遍，建出两个值班会话 | `dsh-webhook` |
| 32 | [`skills-demo`](skills-demo/) | 仓库里的同名 skill 顶替了值班手册 | `dsh-skills` |
| 33 | [`guard-demo`](guard-demo/) | 部署超时后模型重试，平台收到三次部署 | `dsh-guard` |
| 34 | [`instructions-demo`](instructions-demo/) | 仓库的大 AGENTS.md 挤掉值班组全局规则 | `dsh-agent-instructions` |

## release-lookup

在 DeepSeek Harness 仓库根目录执行（`scratch-plugin/release-lookup` 应尚不存在）：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/release-lookup scratch-plugin/release-lookup
node scratch-plugin/release-lookup/configure.mjs
node --import tsx/esm --test scratch-plugin/release-lookup/release-tool.test.ts
pnpm exec tsc -p scratch-plugin/release-lookup/tsconfig.json --pretty false
pnpm dsh --profile web --patch ./scratch-plugin/release-lookup/cordis.generated.yml --no-open --port 3081
```

配置生成器根据文件实际位置解析路径；移动仓库后重新运行即可。模型凭据使用本机配置。生成的本机配置不纳入版本控制。

- `release-lookup/release-tool.ts`：工具注册、参数和数据校验、环境过滤、时间排序。
- `release-lookup/releases.json`：虚构发布记录，不代表实际部署状态。
- `release-lookup/release-tool.test.ts`：12 项运行时测试。
- `release-lookup/configure.mjs`：生成本机 Cordis patch。
- [案例说明](release-lookup/README.md)：环境前提、查询示例及结果解释。

实测基线：DeepSeek Harness `0.1.5-rc.2`，commit `c291e7961a515f6d7af9304e7fd1d257929aef26`；Node v25.2.1、pnpm 11.7.0。
