# subagent-demo

配套文章《DeepSeek Harness 源码：每个服务派一个子 agent，父 agent 自己拉黑的回滚工具子 agent 照样能调》（系列第 19 篇）。

用“每个服务派一个子 agent 查最近一次发布，主 agent 汇总”这个场景，挂载真实的 `dsh-subagent`、spawn 与 fork 两个进程内后端、`dsh-tool-subagent`、`dsh-tool-subagent-control` 验证委派：
默认的后台 `subagent` 派出即返回，结果靠结束通知送回、父 agent 被通知唤醒；`run_in_background: false` 同一步拿齐结果，子 agent 随即回收、会话留在持久化里；
fork 子 agent 看得到之前的轮次、看不到当前这一轮；父 agent 在自己作用域上 deny 的工具子 agent 照样能调，写进 preset 或委派工具 `toolFilter` 的限制才会跟过去；
委派默认只能一层；后台子 agent 同时最多 8 个，第 9、10 个被拒。

`oncall-rows.ts` 是 demo 用的 preset 行：注册若干工具，可选地在 preset 常驻作用域上调 `restrict()`。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/subagent-demo scratch-plugin/subagent-demo
node --import tsx/esm scratch-plugin/subagent-demo/subagent-demo.ts
```

文章发布时的代码保留在 `dsh-subagent` 分支，与 `master` 上的本目录相同。

模型是按会话分派动作的假适配器，不需要 API key，也不调用真实模型；发布数据是合成的。
preset 目录、会话日志和查询库写在系统临时目录下，进程退出时删除。
脚本每一步都带断言，行为与文章不符时以非零退出码结束。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
