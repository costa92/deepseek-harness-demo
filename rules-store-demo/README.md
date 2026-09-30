# rules-store-demo

配套文章《DeepSeek Harness 源码：一条坏记录让规则存储打不开，守卫消失》（系列第 22 篇）。

`rule-store.ts` 把发布规则写成数据，和部署历史一起存进 `dsh-storage-domain`（后端 `dsh-storage-json`）：`revisions` 表存每个版本，`active` 表存生效指针，`events` 表存部署历史；守卫同步读这几张表，回滚就是把指针指回旧版本。
`rules-store-demo.ts` 挂载真实的 `dsh-system-prompt`、`dsh-tools`、`dsh-storage`、`dsh-storage-json`、`dsh-storage-domain`，直接调 `ctx.tools.execute()` 部署，验证：
重启后规则和历史仍在；修改追加版本、回滚改指针；写入先落盘再进内存，工具刚返回时规则读不到这次结果；关宿主时排队的写入失败；
不合 schema 的规则写得进去，重启时整个领域报 `invalid-record`，规则插件起不来、守卫消失；`per-record` + `backup-and-skip` 挪走坏记录；两个宿主共用 `single` 布局目录时后写的一方覆盖对方的规则。
另外验证：`countPending` 开关与 agent 循环里同一回复连发、分轮发送时规则能否看到刚写的结果；监听器直接返回 rejected promise 时 dsh 只记一条 warn；
`per-record` 布局拒绝带 `@` 的键、坏记录挪走后生效指针指向缺失的版本；两个宿主各自收到的 `domain/changed`，`per-record` 布局下规则不被覆盖。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/rules-store-demo scratch-plugin/rules-store-demo
node --import tsx/esm scratch-plugin/rules-store-demo/rules-store-demo.ts
```

文章首次发布时的代码保留在 `dsh-rules-store` 分支；2026-09-30 补测后，`master` 上的本目录新增了步骤与断言，与该分支不同。

不需要 API key，也没有模型和 agent 循环；发布平台是合成的。“重启”是在同一个进程里销毁 cordis 根上下文再重建，“两个宿主”是同一进程里的两个根上下文。
数据写在系统临时目录，脚本退出时删除。本机为 Linux，其他平台未验证。
zod 是 `dsh-storage-domain` 的依赖，没有装在仓库根，脚本按 pnpm 的安装路径 `packages/storage/storage-domain/node_modules/zod` 引入。
脚本每一步都带断言，行为与文章不符时以非零退出码结束。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
