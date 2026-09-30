# tree-demo

配套文章《DeepSeek Harness 源码：一个插件挂两份配置，改配置就是重启》（系列第 7 篇）。

九步验证 Cordis 的插件树机制：一个插件挂两份配置得到两个 Fiber、`fiber.update()`
是完整重启而不是打补丁、监听 `internal/update` 可以否决这次重启、两个 isolate realm
里的同名服务互不可见、root 看不到被隔离的服务，最后复刻 HMR 的核心动作——
`registry.delete()` 之后按 `runtime.fibers` 逐个重挂，每个实例带回自己的配置。另外验证同名 label 的 isolate 得到同一个 realm、不带 global 的 `internal/update`
监听器只看到自己的 Fiber、对 `plugin()` 返回的包装调 `update()`。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/tree-demo scratch-plugin/tree-demo
node --import tsx/esm scratch-plugin/tree-demo/tree-demo.ts
```

文章首次发布时的代码保留在 `cordis-tree` 分支；2026-09-30 补测后，`master` 上的本目录新增了步骤与断言，与该分支不同。

脚本带断言，行为与文章不符时以非零退出码结束。

脚本只使用 vendor 里的 Cordis，不启动 dsh 进程，也不调用模型；配置内容为合成演示数据。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`，vendor Cordis `4.0.2`。
