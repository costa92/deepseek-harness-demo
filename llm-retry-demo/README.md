# llm-retry-demo

配套文章《DeepSeek Harness 源码：模型请求重试的预算按步算，normal 模式下 Retry-After 太长就不重试》（系列第 26 篇）。

写一个按剧本失败的假模型提供方，给发布值班 agent 挂上 `dsh-llm-retry` 和 `dsh-token-meter`，逐项检查限流、中途断流、未知错误和认证失败时本轮怎么结束、日志里留下什么、token 怎么计。
- `llm-retry-demo.ts`：驱动脚本。验证不挂重试时一次 429 就结束本轮；重试请求的消息与失败那次相同；重试预算按步重置；调用块流出后断流时这次部署不执行，失败那次上报的用量计入累计；normal 模式对普通 Error 和超过上限的 Retry-After 不重试，always 模式都重试；always 模式遇到认证失败不停重试，直到用户取消。

## 运行

在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/llm-retry-demo scratch-plugin/llm-retry-demo
node --import tsx/esm scratch-plugin/llm-retry-demo/llm-retry-demo.ts
```

文章发布时的代码保留在 `dsh-llm-retry` 分支，示例源码与 `master` 上的本目录相同，README 的运行方式有更新。

模型提供方是脚本化的：每次请求返回什么、抛什么错误是预先写好的，不需要 API key，也不调用真实模型。重试策略由这个假提供方给出（最多 2 次、20 毫秒起步、上限 200 毫秒、不加抖动，只重试 `RATE_LIMIT` 和 `TRANSPORT`），与 dsh 默认值不同。发布平台是合成的，会话只在内存里。本机为 Linux，其他平台未验证。
脚本每一步都带断言，行为与文章不符时以非零退出码结束，一次运行约 2 秒。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`。
