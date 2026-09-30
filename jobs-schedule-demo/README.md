# jobs-schedule-demo

配套文章《DeepSeek Harness 源码：后台冒烟检查随重启消失，提醒会等到会话恢复》（系列第 29 篇）。

部署工具在部署后用 `ctx.jobs.start()` 把冒烟检查放到后台，由 `dsh-jobs-local` 和 `dsh-tool-jobs` 管理；稍后回查用 `dsh-schedule` 的提醒。会话落盘到临时目录，“重启”是销毁宿主的 Context，再用同一个目录新建宿主、恢复会话。
- `jobs-schedule-demo.ts`：驱动脚本。验证完成通知在轮次进行中注入下一步、空闲时开一轮唤醒；`job_output` 带 `wait` 读到结果后不再通知；没挂 `dsh-tool-jobs` 时检查启动失败；唤醒预算用完后第 4 条通知要等用户下一条消息；宿主重启时检查被取消且没有通知，重启后编号从 `smoke-1` 重新开始；提醒以插件消息的形式到达；提醒到期时宿主不在，恢复会话后才送达，而不挂 schedule 的宿主恢复同一会话时不送达。另外验证 `job_kill`、提醒开的一轮带进通知但不恢复唤醒预算、恢复会话的新实例预算满额、agent 忙时提醒等这一轮结束、送达后不重发，以及用子进程跑宿主并 SIGKILL 后恢复。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/jobs-schedule-demo scratch-plugin/jobs-schedule-demo
node --import tsx/esm scratch-plugin/jobs-schedule-demo/jobs-schedule-demo.ts
```

文章首次发布时的代码保留在 `dsh-jobs-schedule` 分支；2026-09-30 补测后，`master` 上的本目录新增了步骤与断言，与该分支不同。

模型是脚本化的，不需要 API key，也不调用真实模型。发布平台和冒烟检查是合成的，检查用定时器模拟。提醒用真实时钟（最短 1 秒），输出里的时间戳替换成了 `<UTC>`。会话日志写在系统临时目录，脚本退出时删除。本机为 Linux，其他平台未验证。
脚本每一步都带断言，行为与文章不符时以非零退出码结束，一次运行约 20 秒，大部分时间在等提醒到期和定时观察。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
