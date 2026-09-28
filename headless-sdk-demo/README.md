# headless-sdk-demo

配套文章《DeepSeek Harness 源码：部署被拒退出码仍是 0，SDK 客户端对审批请求只能看不能答》（系列第 30 篇）。

从 dsh 进程外面驱动发布值班 agent：先用 `dsh --profile headless` 一次一个任务，再用 TypeScript SDK（`@deepseek-ai/dsh-sdk-client`）常驻一个 `dsh --profile sdk` 子进程。子进程里的模型、工具和审批门由补丁文件挂进去。

- `duty-plugin.ts`：子进程里的插件。注册脚本化模型 `scripted/mock`、查询工具 `read_releases`、部署工具 `deploy_release`（真部署时往工作目录的 `deploys.jsonl` 追加一行），以及让每次部署返回 `ask` 的 `tools/pre-execute` 监听器。
- `duty.cordis.patch.yml`：把默认模型换成 `scripted/mock`，挂上 `duty-plugin.ts`。
- `ci.cordis.patch.yml`：在权限预设表里加一个“沙箱照旧、审批一律拒绝”的 `ci` 预设并设为默认。按 id 打的补丁会整体替换这一行的 `config`，所以 base 原有的三个预设也照抄了一遍。
- `approval-bridge.ts` 与 `bridge.cordis.patch.yml`：子进程里的审批应答者，等父进程在共享目录写 `<sessionId>.<callId>.answer`（父进程先写临时文件再改名），超时按审批通道不可用处理。
- `headless-sdk-demo.ts`：父进程脚本。验证 headless 的 stdout、stderr 和退出码；没人应答时部署被拒但退出码仍为 0，`--json` 事件流里没有审批事件；`ci` 预设下的拒绝文字；`--session-id` 接续会话及其拒绝条件；SDK 客户端在运行中收到 `approval/asked` 却无从回答；`run()` 在模型出错时照常返回；新 SDK 进程不能沿用同一个 sessionId，headless 却可以；审批桥下批准、拒绝和超时三种结果。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/headless-sdk-demo scratch-plugin/headless-sdk-demo
node --import tsx/esm scratch-plugin/headless-sdk-demo/headless-sdk-demo.ts
```

文章发布时的代码保留在 `dsh-headless-sdk` 分支，与 `master` 上的本目录相同（仅本句为 master 所加）。

脚本从源码启动 dsh（`node --import tsx/esm apps/cli/src/bin.ts`），每个子进程用临时的 `DSH_HOME` 和工作目录，脚本退出时删除。模型是脚本化的，不需要 API key，也不调用真实模型；发布平台是合成的。输出里的会话 id 和临时路径替换成了 `session-<uuid>`、`<work>`、`<other>`。本机为 Linux，其他平台未验证。
脚本每一步都带断言，行为与文章不符时以非零退出码结束，一次运行约 11 秒，大部分时间花在启动 dsh 子进程上。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
