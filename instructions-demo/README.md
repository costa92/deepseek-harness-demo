# instructions-demo

配套文章《DeepSeek Harness 源码：仓库的大 AGENTS.md 挤掉值班组全局规则》（系列第 34 篇）。

dsh 基础组合默认挂着 `dsh-agent-instructions`，它把 `$DSH_HOME/AGENTS.md` 和项目里从根目录到会话目录的 `AGENTS.md`/`CLAUDE.md` 拼成一条指令，在第一次请求前放进会话。脚本在一个进程里挂上本地文件系统、`read`/`write`/`edit` 工具和这个插件（预算用发行版的 65536 字节），用脚本化模型驱动几个内存会话。

- `instructions-demo.ts`：分 4 节验证：
  - 指令链的顺序是全局规则、仓库根、会话目录；内容相同的 `CLAUDE.md` 不重复渲染；
  - 仓库根有一个约 64 KB 的 `AGENTS.md` 时，超出预算，最先被省略的是值班组的全局规则；
  - 会话进行中在会话外改文件、加本地叠加文件、给中间目录加 `AGENTS.md`，人只发一句“继续”，下一次请求就带上了；改动前的版本仍留在会话里；
  - 会话目录以下的 `AGENTS.md` 要等模型用 `read` 读到那个目录才加载，途经的目录一起加载；名字不叫 `read` 的工具读同一个文件不算；会话目录之外的不加载。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/instructions-demo scratch-plugin/instructions-demo
node --import tsx/esm scratch-plugin/instructions-demo/instructions-demo.ts
```

模型是脚本化的，不需要 API key，也不调用真实模型。`DSH_HOME` 和两个仓库都建在系统临时目录，脚本退出时删除，会话只在内存。本机为 Linux，其他平台未验证。
脚本每一步都带断言，行为与文章不符时以非零退出码结束，一次运行不到 1 秒。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
