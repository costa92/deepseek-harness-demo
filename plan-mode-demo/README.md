# plan-mode-demo

配套文章《DeepSeek Harness 源码：计划模式下调部署工具，平台照样上线》（系列第 35 篇）。

dsh 基础组合默认挂着 `dsh-plan-mode`：`/plan` 进入计划模式后，每次请求多一段计划引导；模型用 `exit_plan_mode` 提交计划，经人评审批准后离开。脚本在一个进程里挂上 agent 循环、命令服务、用户提问服务和 plan-mode（引导文本原样取自基础组合），会话落盘为 JSONL，用脚本化模型驱动值班会话，工具背后是一个合成的发布平台。

- `plan-mode-demo.ts`：分 8 步验证：
  - 计划模式下模型直接调部署工具，照样执行，平台收到部署，没有任何提醒；
  - 模型用文字回一份计划、人回“照这个做”，计划模式都不会结束，部署照样执行；
  - `exit_plan_mode` 提交计划：没有应答者时报错、计划不以 `# ` 开头时报错、打回时意见原样回给模型、批准后计划状态在下一步开始前才切换；
  - 自己加一道读计划状态的守卫：同一条回复里先提交计划再部署，批准了部署仍被拒，下一步才放行；
  - 叠加 `ask` 审批：审批人先批准，守卫再拒绝；用权限预设服务切到 `danger-full-access`（写入 `approval/policy never`）后，计划评审照样问人，部署被自动拒绝；
  - 轮中发的 `/plan off` 在同一进程下一步生效，重启宿主后丢失，界面投影仍显示“待生效”；
  - 评审人关掉评审改为发言、评审期间 plan-mode 重载，两种情况都报错并留在计划模式；
  - fork 出的会话继承已记录的计划状态。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/plan-mode-demo scratch-plugin/plan-mode-demo
node --import tsx/esm scratch-plugin/plan-mode-demo/plan-mode-demo.ts
```

文章首次发布时的代码见 `master` 上的提交 `6254257`；2026-09-30 补测后，本目录新增了步骤与断言。

模型和审批人、评审人都是脚本化的，不需要 API key，也不调用真实模型。发布平台是合成的；会话日志写在系统临时目录，脚本退出时删除；重启宿主用同一进程内销毁 Context 再重新组装模拟。本机为 Linux，其他平台未验证。
脚本每一步都带断言，行为与文章不符时以非零退出码结束，一次运行约 1 秒。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
