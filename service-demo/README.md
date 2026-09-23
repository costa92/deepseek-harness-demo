# service-demo

配套文章《DeepSeek Harness 源码：换掉数据源，插件一行都不用改》（系列第 5 篇）。

演示 Cordis 的 Service 与 inject：`release-lookup` 只声明 `inject: ['releases']`，
文件版与模拟平台版数据源可以互换，插件代码一行不用改。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone -b cordis-service https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/service-demo scratch-plugin/service-demo
node --import tsx/esm scratch-plugin/service-demo/service-demo.ts
```

脚本只使用 vendor 里的 Cordis，不启动 dsh 进程，也不调用模型；发布数据为合成演示数据。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`，vendor Cordis `4.0.2`。
