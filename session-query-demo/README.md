# session-query-demo

配套文章《DeepSeek Harness 源码：跨会话搜得出 demo-003，却搜不到“回滚”》（系列第 14 篇）。

先用真实的 agent 循环和 JSONL 持久化写出 5 个值班会话（其中 3 个是 fork），再换一个新的 Context，
只凭磁盘上的日志，用 `ctx.sessionQuery` 和 `dsh-session-query-sqlite`（SQLite FTS5）做十一步查询：
跨会话搜出所有提到 demo-003 的会话（fork 子会话会因继承的日志被一起搜出）；中文词在句子里不是独立
token，搜“回滚”找不到，`filterEvents()` 的子串扫描能找到；追踪 fork 谱系，删掉根会话后链条标为不完整、
索引随磁盘同步；从一条搜索命中追回它对应的工具调用；`readSession()` 读已落盘的 fork 子会话时报错，
`readSurface()` 能正常读。另外验证 base bundle 配置下搜索被拒、精确读取和谱系照常；trigram 分词（直接在 node:sqlite 里探测）
仍搜不到两个字的词；被剪枝对模型隐藏的内容仍能搜到并标为 shadowed；首次搜索后写入的内容由对账补进索引；活会话从内存搜索，
活的 fork 同样 `readSession()` 失败；`tool-session-query` 由调用方 agent 的 cwd 决定模型能看到什么。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/session-query-demo scratch-plugin/session-query-demo
node --import tsx/esm scratch-plugin/session-query-demo/session-query-demo.ts
```

文章首次发布时的代码保留在 `dsh-session-query` 分支；2026-09-30 补测后，`master` 上的本目录新增了步骤与断言，与该分支不同。

模型是脚本里写死回复的假适配器，不需要 API key，也不调用真实模型；会话内容是合成的演示数据。
全文搜索插件直接挂载并使用插件默认的 `openAt: startup`，base bundle 默认关闭全文搜索。
会话日志和索引文件写在系统临时目录下，退出时删除。脚本每一步都带断言，行为与文章不符时以非零退出码结束。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
