# pipeline-demo

配套文章《DeepSeek Harness 源码：前置监听器能放行全量查询，守卫只能拒绝》（系列第 9 篇）。

十三步验证 `ctx.tools` 的执行管线：一次调用依次经过 pre-execute、守卫、execute、工具体、
post-execute、finalizeContent 和 tools/result；写在 pre-execute 里的"禁止全量查询"会被前置的
allow-all 监听器绕过，同一规则改成 `tools.guard()` 后拦得住；被拒的调用照样经过 post-execute；
没有审批服务时 `ask` 降级为拒绝；`timeout-policy` 超时后替换结果，但会等工具体收尾；
post-execute 替换的值会按 output schema 再校验；监听器抛错时调用直接失败；
`tools/execute` 里改 `exec.arguments` 的字段会报错，但守卫放行后整个换掉参数、换工具名都能生效，换进来的返回值同样校验；
作用域链上的守卫先全局、再由远及近；`ask` 的默认理由、没有 agent 时的拒绝与四种审批结果；工具失败照样经过 post-execute；
调用方在分发前和工具体开始后取消。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/pipeline-demo scratch-plugin/pipeline-demo
node --import tsx/esm scratch-plugin/pipeline-demo/pipeline-demo.ts
```

文章首次发布时的代码保留在 `dsh-pipeline` 分支；2026-09-30 补测后，`master` 上的本目录新增了步骤与断言，与该分支不同。

脚本带断言，行为与文章不符时以非零退出码结束。

脚本里的 `lookup_release` 是简化版（`service` 可选、数据在内存中），不是 `release-lookup/` 下的正式插件。
不启动 agent 循环，也不调用模型；第 5 步的耗时以约数输出，个别机器上可能有 10ms 级别的偏差。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
