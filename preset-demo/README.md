# preset-demo

配套文章《DeepSeek Harness 源码：切换 preset 后，加入时设的白名单失效》（系列第 17 篇）。

用一个“发布值班”preset（自己的人设、两个值班工具、一份 runbook）和一个通用 preset，在同一进程里验证 `dsh-agent-presets` 的按会话组装：
名单把坏 preset 连同原因列出，开会话时整体拒绝；两个会话的工具和提示词互不相干，同一 preset 只挂一份；
比较几种挡住宿主全局工具的写法：preset 行在常驻作用域 `restrict` 只能拉黑名单，白名单要落到 agent 作用域
（宿主 `setup` 里，或 preset 行监听 `agent/created`），而空会话经 `select()` 切进来时收不到 `agent/created`，白名单不生效；
最后只改 runbook 与改 `agent.cordis.yml`，看新旧会话各拿到哪一份常驻挂载。另外验证：不关 `includeShippedRoot` 时名单多出随附 preset；两个会话同时首次选同一 preset 仍只挂一份；
`dsh-persona` 挂到全局层报重复注册；宿主后来注册的工具对三种写法的影响；已跑过一轮的会话不能再切；旧的白名单不撤时新白名单不生效；
切到坏 preset 时留在原 preset；带 `dsh-skill-filesystem` 的 preset 每改一次目录多一个文件监听器。

- `preset-demo.ts`：宿主组装、五步实测与断言。
- `oncall-rows.ts`：案例自己的 preset 插件行（注册工具、读取 runbook、`restrict` 与 `allowOnJoin` 两种限制写法）。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/preset-demo scratch-plugin/preset-demo
node --import tsx/esm scratch-plugin/preset-demo/preset-demo.ts
```

文章首次发布时的代码保留在 `dsh-preset` 分支；2026-09-30 补测后，`master` 上的本目录新增了步骤与断言，与该分支不同。

preset 目录和 `DSH_HOME` 都建在系统临时目录下，进程退出时删除。`dsh-persona` 按包名从 `apps/cli` 解析，需要该目录的依赖已安装。
模型是脚本里写死回复的假适配器，不需要 API key，也不调用真实模型；会话只在内存里。脚本每一步都带断言，行为与文章不符时以非零退出码结束。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
