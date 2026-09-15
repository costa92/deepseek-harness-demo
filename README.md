# deepseek-harness-demo

DeepSeek Harness 实战示例：为 Agent 添加只读发布记录查询工具 `lookup_release`。

## 使用方式

本仓库保存示例代码。示例依赖 DeepSeek Harness 源码工作区，请先准备已安装依赖并完成构建的 DeepSeek Harness 仓库。

在 **DeepSeek Harness 仓库根目录** 执行以下命令，将示例放到它需要的目录层级。`scratch-plugin/deepseek-harness-demo` 和 `scratch-plugin/release-lookup` 应尚不存在。

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/release-lookup scratch-plugin/release-lookup
node scratch-plugin/release-lookup/configure.mjs
node --import tsx/esm --test scratch-plugin/release-lookup/release-tool.test.ts
pnpm exec tsc -p scratch-plugin/release-lookup/tsconfig.json --pretty false
pnpm dsh --profile web --patch ./scratch-plugin/release-lookup/cordis.generated.yml --no-open --port 3081
```

配置生成器根据文件实际位置解析路径；移动仓库后重新运行即可。模型凭据使用本机配置。生成的本机配置不纳入版本控制。

## 内容

- `release-lookup/release-tool.ts`：工具注册、参数和数据校验、环境过滤、时间排序。
- `release-lookup/releases.json`：虚构发布记录，不代表实际部署状态。
- `release-lookup/release-tool.test.ts`：11 项运行时测试。
- `release-lookup/configure.mjs`：生成本机 Cordis patch。
- [案例说明](release-lookup/README.md)：环境前提、查询示例及结果解释。

实测基线：DeepSeek Harness `0.1.5-rc.2`，commit `c291e7961a515f6d7af9304e7fd1d257929aef26`；Node v25.2.1、pnpm 11.7.0。
