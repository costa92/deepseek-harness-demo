# mcp-client-demo

配套文章《DeepSeek Harness 源码：发布平台改成 MCP 服务器后，规则引擎认不出部署，dsh 也不校验参数》（系列第 27 篇）。

把合成发布平台放进一个手写的本地 MCP 服务器，用 `dsh-mcp-client` 接入，再挂上第 21 篇的规则引擎和第 24 篇的审批。
- `release-mcp-server.mjs`：MCP stdio 服务器，不依赖 SDK，逐行读写 JSON-RPC；每次启动、每个请求、每次部署都记进账本文件。
- `release-rules.ts`：第 21 篇的发布规则引擎，加了 `outcomeOf` 配置项，用来从 MCP 结果的 `structuredContent` 里读部署结果。
- `mcp-client-demo.ts`：驱动脚本。验证模型看到的工具名和 schema、服务器 instructions 进系统提示、一次连接启动两个服务器进程、凭据形环境变量被去掉；规则引擎按工具名和结果字段认不出 MCP 部署；dsh 不校验 MCP 工具参数；服务器在回复前崩溃时部署已执行、断开期间调用失败、重连预算在稳定窗口内共用、耗尽后工具被移出注册表。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/mcp-client-demo scratch-plugin/mcp-client-demo
node --import tsx/esm scratch-plugin/mcp-client-demo/mcp-client-demo.ts
```

文章发布时的代码保留在 `dsh-mcp-client` 分支，与 `master` 上的本目录相同。

模型和审批人都是脚本化的，不需要 API key，也不调用真实模型。发布平台是合成的，时钟固定。MCP 服务器由 dsh 以当前 Node 可执行文件启动为子进程；账本写在系统临时目录，脚本退出时删除。脚本进程会设置一个假的 `RELEASE_API_TOKEN` 环境变量，用来观察它是否传给服务器。重连策略缩短了延迟。本机为 Linux，其他平台未验证。
脚本每一步都带断言，行为与文章不符时以非零退出码结束，一次运行约 1 秒。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`；MCP SDK `@modelcontextprotocol/client` `2.0.0`。
