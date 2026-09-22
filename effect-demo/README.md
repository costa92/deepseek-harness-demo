# effect-demo

《DeepSeek Harness 源码：插件卸载后，它注册的东西去哪了》配套脚本。只使用 DeepSeek Harness 内置的 Cordis，演示插件等待依赖、副作用逆序撤销、卸载后禁止注册、依赖消失后退回 PENDING。不启动 dsh，不调用模型。

在 **DeepSeek Harness 仓库根目录** 执行：

```sh
mkdir -p scratch-plugin
git clone -b cordis-effect https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/effect-demo scratch-plugin/effect-demo
node --import tsx/esm scratch-plugin/effect-demo/effect-demo.ts
```

预期输出：

```text
1. load plugin before toolbox exists
  state=0 (0=PENDING)
2. provide toolbox
  + tool lookup_release
  + cache timer
  + cache map
  state=2 (2=ACTIVE) tools=lookup_release
  release changed: demo-003
3. dispose release-lookup
  - cache map
  - cache timer
  - tool lookup_release
  tools=[]
  (no listener output above)
4. effect on disposed fiber
  Error: INACTIVE_EFFECT
5. dispose toolbox while a new plugin depends on it
  + tool lookup_release
  + cache timer
  + cache map
  - cache map
  - cache timer
  - tool lookup_release
  dependent state=0 (0=PENDING)
```

实测基线：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`（vendor Cordis `4.0.2`）；Node v22.22.0。
