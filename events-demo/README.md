# events-demo

配套文章《DeepSeek Harness 源码：五种事件分发，waterfall 不是流水线》（系列第 6 篇）。

在一条发布查询链路上跑完 Cordis 的五种分发模式：waterfall 的洋葱序与否决、
bail 的中止判定、emit 吞返回值、parallel 聚合错误、serial 串行短路，
卸载脱敏插件，验证监听器随插件消失；另外验证监听器抛错时 serial / bail / waterfall 的表现、没人 bail 与中间件返回 undefined、
`isBailed` 的边界值、emit 遇到异步监听器 reject，最后销毁根上下文。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/events-demo scratch-plugin/events-demo
node --import tsx/esm scratch-plugin/events-demo/events-demo.ts
```

文章首次发布时的代码保留在 `cordis-events` 分支；2026-09-30 补测后，`master` 上的本目录新增了步骤与断言，与该分支不同。

脚本带断言，行为与文章不符时以非零退出码结束。

脚本只使用 vendor 里的 Cordis，不启动 dsh 进程，也不调用模型；发布数据与 token 均为合成演示数据。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`，vendor Cordis `4.0.2`。
