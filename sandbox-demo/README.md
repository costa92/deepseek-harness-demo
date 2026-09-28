# sandbox-demo

配套文章《DeepSeek Harness 源码：沙箱拦住了越界写入，却在中文系统上认不出自己的拒绝》（系列第 10 篇）。

七步验证 dsh 的进程沙箱：一条"拉取发布日志"的 bash 命令经 `ctx.sandbox` 包成 bwrap 再执行；
`read-only` 能读不能写，`workspace-write` 只有工作区能留下结果、`/tmp` 是随命令销毁的 tmpfs；
读取工作区外的文件和连接本机网络不受模式限制；"被拒绝"从 stderr 文本推断，中文 locale 下
拒绝标记与升权提示消失；没有可用 runner 时受限模式拒绝执行，`danger-full-access` 不经过沙箱；
升权只接受严格更宽的模式，且只对一次调用有效。

## 运行

需要 Linux 与可用的 bubblewrap（`bwrap --ro-bind / / -- true` 能成功）。在 **DeepSeek Harness 仓库根目录**（已 `pnpm install` 并完成构建）执行：

```sh
mkdir -p scratch-plugin
git clone -b dsh-sandbox https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/sandbox-demo scratch-plugin/sandbox-demo
node --import tsx/esm scratch-plugin/sandbox-demo/sandbox-demo.ts
```

脚本在 HOME 下建两个临时目录（工作区和"工作区外"），退出时删除；`deploy.env` 里是伪造的 token。
第 5 步需要系统装有 `zh_CN.UTF-8` locale，没装时打印提示并跳过中文对照。脚本每一步都带断言，
行为与文章不符时以非零退出码结束。不启动 agent 循环，也不调用模型。

本机验证环境：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`；Linux 6.8，bubblewrap 0.9.0。
