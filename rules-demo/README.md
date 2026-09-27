# rules-demo

配套文章《DeepSeek Harness 源码：在工具流水线上搭发布规则引擎，守卫只看到原始参数，版本写成 v2.3 就绕过了规则》（系列第 21 篇）。

`release-rules.ts` 是一个挂在 dsh 工具流水线上的发布风险规则引擎：`tools/result` 记历史，守卫拦截，`tools/post-execute` 追加告警；每条规则包成一个插件，卸载即撤销。
`rules-demo.ts` 挂载真实的 `dsh-llm`、`dsh-tools`、`dsh-agent`、`dsh-agent-loop`、`dsh-system-prompt`、会话存储与会话投影，验证：
同一版本失败两次后第三次被守卫拦下，被拒结果没有错误码；查询时工具结果后面多一条来源为插件的告警消息；
版本写成 `v2.3` 时规则按原字符串比较而放行，引擎配置 `normalize` 后被拦；卸载引擎后规则插件回到等待状态，重载后规则自动回来但历史清零；
时钟拨快 25 小时后放行；强转进去的 async 守卫让所有工具报 JSON 序列化错误。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone -b dsh-rules https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/rules-demo scratch-plugin/rules-demo
node --import tsx/esm scratch-plugin/rules-demo/rules-demo.ts
```

模型是按轮次执行预设动作的假适配器，不需要 API key，也不调用真实模型；发布平台、它的数据和时钟都是合成的。
规则引擎的历史只在内存里，引擎重载或进程退出即清零。
脚本每一步都带断言，行为与文章不符时以非零退出码结束。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
