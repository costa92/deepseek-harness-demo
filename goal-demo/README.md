# goal-demo

配套文章《DeepSeek Harness 源码：巡检目标自动续跑了 5 轮，只查 2 个服务就说完成也照样通过》（系列第 18 篇）。

用“巡检 5 个服务最近一次发布，找出失败的”这个目标，挂载真实的 `dsh-goal`、`dsh-tool-goal`、`dsh-goal-round-driver` 验证同会话续跑：
一条人类消息之后驱动器自动开 5 轮并完成；模型只查 2 个服务就标记完成也被接受（没有评估器）；
受阻门槛只比较轮次编号，第 3 轮第一次报受阻也被接受；轮数上限由模型在 `create_goal` 里给出，用完后记 `round-limit`；
巡检到一半销毁 Context，恢复后目标仍是 active 但续行被停用，经过一次空闲也不会自己续跑，要人类说“继续”才恢复。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone -b dsh-goal https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/goal-demo scratch-plugin/goal-demo
node --import tsx/esm scratch-plugin/goal-demo/goal-demo.ts
```

模型是脚本里写死每一轮动作的假适配器，不需要 API key，也不调用真实模型；发布数据是合成的。
会话日志写在系统临时目录下，进程退出时删除。“进程退出”是在同一个 Node 进程里销毁再重建 Context 模拟的，没有真的杀进程。
脚本每一步都带断言，行为与文章不符时以非零退出码结束。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
