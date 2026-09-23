# events-demo

配套文章《DeepSeek Harness 源码：五种事件分发，waterfall 不是流水线》（系列第 6 篇）。

在一条发布查询链路上跑完 Cordis 的五种分发模式：waterfall 的洋葱序与否决、
bail 的中止判定、emit 吞返回值、parallel 聚合错误、serial 串行短路，
最后卸载脱敏插件，验证监听器随插件消失。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone -b cordis-events https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/events-demo scratch-plugin/events-demo
node --import tsx/esm scratch-plugin/events-demo/events-demo.ts
```

脚本只使用 vendor 里的 Cordis，不启动 dsh 进程，也不调用模型；发布数据与 token 均为合成演示数据。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`，vendor Cordis `4.0.2`。
