# tools-demo

配套文章《DeepSeek Harness 源码：ctx.fs 能整个换，ctx.tools 不能》（系列第 8 篇）。

十一步验证 dsh 的能力 seam 与工具注册表：`tool-fs` 在没有 `ctx.fs` 时不注册任何工具；把 `fs-local`
换成 `fs-sandbox` 后，工具代码不变，`write` 却多出提权参数、写入被 `FS_SANDBOX_DENIED` 拒绝；
`ctx.tools.register()` 拒绝没有 output 契约的工具；`schemas()` 只投影 name/description/parameters；
输出多出未声明字段时整次调用返回 `INVALID_TOOL_OUTPUT`；agent 作用域内的同名注册遮蔽全局工具、
`restrict()` 屏蔽全局工具；作用域卸载后这些改动全部自动撤销。另外验证 `fs-sandbox` 提权只批准一次更宽的重试；
`restrict()` 的硬检查，`tools/change` 不按作用域过滤；真实 agent 步骤里模型请求带什么；PTC 模式下 SDK 声明带上输出形状。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/tools-demo scratch-plugin/tools-demo
node --import tsx/esm scratch-plugin/tools-demo/tools-demo.ts
```

文章首次发布时的代码保留在 `dsh-tools` 分支；2026-09-30 补测后，`master` 上的本目录新增了步骤与断言，与该分支不同。

脚本带断言，行为与文章不符时以非零退出码结束。

脚本挂载真实的 dsh 包，直接调用 `ctx.tools.execute()`，不启动 agent 循环，也不调用模型。
文件写入发生在系统临时目录，运行结束后删除；发布记录为合成演示数据。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
