# skills-demo

配套文章《DeepSeek Harness 源码：仓库里的同名 skill 顶替了值班手册》（系列第 32 篇）。

把发布值班的运行手册做成 dsh 的 skill，看它从哪里被发现、怎样进入会话、谁能调用，以及写错或改动之后会怎样。脚本在一个进程里挂上 skill 注册表（`dsh-skill`）、本地文件提供方（`dsh-skill-filesystem`）和 `dsh-tool-skill`，用脚本化模型驱动一个内存会话。

- `skills-demo.ts`：
  - 在临时目录里建值班组的用户 skill（`release-runbook`、只允许人调用的 `deploy-now`、只允许模型调用的 `postmortem`），另建一个带 `.git` 的发布仓库，仓库的 `.dsh/skills/ci-notes/SKILL.md` 也声明 `name: release-runbook`。
  - 分 5 节验证：同名 skill 由仓库那份胜出；会话目录只含名字和描述，且只发一次；模型调 `skill` 工具和人在消息里写 `/name` 两条路径各认哪条策略、手势在句中和紧跟全角标点时的表现；会话进行中加进三个 frontmatter 写错的 skill；只改正文时目录不动、下一次加载拿到新内容。
  - 挂一个日志 exporter（放开到 warn 级别）收集 skill 相关的警告。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/skills-demo scratch-plugin/skills-demo
node --import tsx/esm scratch-plugin/skills-demo/skills-demo.ts
```

文章发布时的代码保留在 `dsh-skills` 分支，与 `master` 上的本目录相同（仅本句为 master 所加）。

模型是脚本化的，不需要 API key，也不调用真实模型。skill 目录、发布仓库和用户目录都建在系统临时目录，脚本退出时删除，输出里的临时路径替换成了 `<tmp>`。脚本会忽略环境变量 `DSH_BUNDLED_SKILL_DIR`。本机为 Linux，其他平台未验证。
脚本每一步都带断言，行为与文章不符时以非零退出码结束，一次运行约 1 秒。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
