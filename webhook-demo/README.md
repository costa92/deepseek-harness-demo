# webhook-demo

配套文章《DeepSeek Harness 源码：webhook 同一投递送两遍，建出两个值班会话》（系列第 31 篇）。

发布平台用带签名的 GitHub 风格 webhook 通知“生产发布失败”，dsh 的 webhook 规则据此在 Web Workspace 里开一个值班会话。脚本起一个真实的 `dsh --profile web` 子进程，webhook 运行时、规则和专用监听器都由补丁挂进去，父进程用 `fetch` 发签名请求，再读子进程写的探针文件做断言。

- `duty-plugin.ts`：子进程里的插件。注册脚本化模型 `scripted/mock`（记下每次请求里消息的角色和来源）、部署工具 `deploy_release`；父进程放下 `gate-deploy` 文件后，部署改为返回 `ask`；父进程写 `human-<sessionId>.txt` 时，以 `user` 来源追加一条消息，模拟 Web UI 的人类输入；另挂一个日志 exporter，把 webhook 的警告抄到探针文件。
- `release-webhook-rule.ts`：可信规则。只接 `deployment_status` 事件里 production 的失败，缺 `deployment` 对象就抛错；按配置对部分来源按投递 id 去重（只在内存里）；`brokenSources` 里的来源故意把权限预设名写错，模拟建会话失败。
- `duty.cordis.patch.yml`：把默认模型换成 `scripted/mock`，挂上 `duty-plugin.ts`。
- `webhook.cordis.patch.yml`：照仓库里 `apps/cli/config/examples/github-review/cordis.yml` 的写法，挂 webhook 运行时、规则，以及隔离出来的第二个 WebServer；上面有 `/release`（不去重）、`/release-dedup`（去重）和 `/release-broken`（去重、权限预设写错）三条路由。
- `webhook-demo.ts`：父进程脚本。验证入口的状态码、签名投递建出的会话和首条消息来源、`/release-runbook` 手势只对 `user` 来源生效、规则在 202 之后抛错、同一投递送两遍、payload 里夹带的部署在 `read-only` 预设下照样执行以及加上审批门后停在审批上。另外验证：无 `Content-Length` 的超长 body 与签名错的非 JSON body 的状态码；直接调 llm-deepseek 两种序列化时 webhook 与 `user` 来源结果相同；记下投递 id 后建会话失败、重试被挡掉；webhook 会话里模型自己调 `skill` 加载手册、`create_goal` 被拒而 `user` 来源可以。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/webhook-demo scratch-plugin/webhook-demo
node --import tsx/esm scratch-plugin/webhook-demo/webhook-demo.ts
```

文章首次发布时的代码保留在 `dsh-webhook` 分支；2026-09-30 补测后，`master` 上的本目录新增了步骤与断言，与该分支不同。

脚本从源码启动 dsh（`node --import tsx/esm apps/cli/src/bin.ts --profile web`），用临时的 `DSH_HOME`、`DSH_AGENTS_HOME` 和工作目录，两个端口都取本机空闲端口，退出时关掉子进程并删除临时目录。模型是脚本化的，不需要 API key；发布平台和 webhook 密钥都是合成的。本机为 Linux，其他平台未验证。
脚本每一步都带断言，行为与文章不符时以非零退出码结束，一次运行约 12 秒，大部分时间花在启动 dsh 和定时等待上。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
