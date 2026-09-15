# 发布记录查询插件案例

在 DeepSeek Harness 源码仓库中运行的本地教程插件。数据全部为虚构演示记录，查询不会部署服务或修改数据文件。插件只读取操作者在 `cordis.generated.yml` 指定的文件，模型只能传服务名和环境。

## 前置条件

仓库已安装依赖并完成构建；本次环境为 Node v25.2.1、pnpm 11.7.0、DSH 0.1.5-rc.2（c291e7961a515f6d7af9304e7fd1d257929aef26）。`tsconfig.json` 引用仓库内 vendor 项目，类型检查需要它们已有的构建声明。Web 模型凭据沿用操作者本机设置，不随案例保存。

## 运行

所有命令在 DeepSeek Harness 仓库根目录执行。先运行配置生成器，它根据自身文件位置生成插件和数据文件的绝对路径，无需填写用户名或仓库路径。移动仓库或案例目录后重新生成；生成文件仅供本机运行，不随附件分发。

```sh
node scratch-plugin/release-lookup/configure.mjs
node --import tsx/esm --test scratch-plugin/release-lookup/release-tool.test.ts
pnpm exec tsc -p scratch-plugin/release-lookup/tsconfig.json --pretty false
pnpm dsh --profile web --patch ./scratch-plugin/release-lookup/cordis.generated.yml --no-open --port 3081
```

使用终端输出的带 token 地址进入页面，不分享 token。选择案例目录作为工作区，使用已配置的模型发送：

> 请只调用 lookup_release 查询 payment-api 的 production 发布历史，不使用其他工具。按 UTC 时间列出记录 id、版本和状态，区分最新发布尝试与最近成功记录。不要据此推断当前线上版本。所有记录都是演示数据。

## 数据与结果

`releases.json` 包含 production 成功记录 demo-001、staging 成功记录 demo-002、production 失败记录 demo-003。查询 production 按 UTC 时间降序返回 demo-003、demo-001，不能把失败的 1.8.1 当成已部署版本，也不能用本文件证明线上当前版本。

`lookup_release` 返回 `{status, records}`；没有匹配项时返回 `not_found` 和空数组，调用仍成功。参数错误、无效 JSON、字段缺失、无效 UTC 日期和文件无法读取都会成为工具错误。数据文件按次读取，不缓存；仅面向小型受信任演示文件，不提供分页、权限系统或生产发布平台连接。

## 验证

测试走真实 `ToolRuntime` 调度与参数/输出校验，覆盖环境隔离、时间排序、空结果、参数拒绝、文件错误、数据更新、卸载清理和日期拒绝。它不伪装成模型调用测试。Web 实战另行通过真实模型调用工具，并在轨迹页核对参数、返回记录与结果状态。

演示工具没有专用 Web 卡片，沿用通用工具显示。直接 Node 文件读取不自动继承 DSH 内建文件工具的路径策略；操作者应只配置可信的演示文件。
