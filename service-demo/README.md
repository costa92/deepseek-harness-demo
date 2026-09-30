# service-demo

配套文章《DeepSeek Harness 源码：换掉数据源，插件一行都不用改》（系列第 5 篇）。

演示 Cordis 的 Service 与 inject：`release-lookup` 只声明 `inject: ['releases']`，
文件版与模拟平台版数据源可以互换，插件代码一行不用改。另外验证同一作用域注册第二个同名服务、`ctx.set` 改值不换提供方、不声明 inject 时读取、
服务内的 `this.ctx`、从消费方 `ctx.set`、隔离作用域里的同名服务、提供方加载中 `get(name)` 与 `get(name, false)` 的区别、
`ctx.inject` 子上下文跟随提供方，以及销毁根上下文。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/service-demo scratch-plugin/service-demo
node --import tsx/esm scratch-plugin/service-demo/service-demo.ts
```

文章首次发布时的代码保留在 `cordis-service` 分支；2026-09-30 补测后，`master` 上的本目录新增了步骤与断言，与该分支不同。

脚本带断言，行为与文章不符时以非零退出码结束。

脚本只使用 vendor 里的 Cordis，不启动 dsh 进程，也不调用模型；发布数据为合成演示数据。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`，vendor Cordis `4.0.2`。
