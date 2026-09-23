# tree-demo

配套文章《DeepSeek Harness 源码：一个插件挂两份配置，改配置就是重启》（系列第 7 篇）。

六步验证 Cordis 的插件树机制：一个插件挂两份配置得到两个 Fiber、`fiber.update()`
是完整重启而不是打补丁、监听 `internal/update` 可以否决这次重启、两个 isolate realm
里的同名服务互不可见、root 看不到被隔离的服务，最后复刻 HMR 的核心动作——
`registry.delete()` 之后按 `runtime.fibers` 逐个重挂，每个实例带回自己的配置。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone -b cordis-tree https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/tree-demo scratch-plugin/tree-demo
node --import tsx/esm scratch-plugin/tree-demo/tree-demo.ts
```

脚本只使用 vendor 里的 Cordis，不启动 dsh 进程，也不调用模型；配置内容为合成演示数据。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`，vendor Cordis `4.0.2`。
