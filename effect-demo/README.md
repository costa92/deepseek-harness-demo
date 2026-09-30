# effect-demo

配套文章《DeepSeek Harness 源码：插件卸载时 3 项注册按逆序撤销》（系列第 4 篇）。只使用 DeepSeek Harness 内置的 Cordis，演示插件等待依赖、副作用逆序撤销、卸载后禁止注册、依赖消失后退回 PENDING，以及依赖回来后重新激活、同一撤销函数调两次只执行一次、卸载途中注册副作用被拒、生成器副作用里最后 yield 的异步撤销、同一 Fiber 上两个异步副作用并发撤销、销毁根上下文。不启动 dsh，不调用模型。

在 **DeepSeek Harness 仓库根目录** 执行：

```sh
mkdir -p scratch-plugin
git clone https://github.com/costa92/deepseek-harness-demo.git scratch-plugin/deepseek-harness-demo
cp -R scratch-plugin/deepseek-harness-demo/effect-demo scratch-plugin/effect-demo
node --import tsx/esm scratch-plugin/effect-demo/effect-demo.ts
```

文章首次发布时的代码保留在 `cordis-effect` 分支；2026-09-30 补测后，`master` 上的本目录新增了步骤与断言，与该分支不同。

脚本带断言，行为与文章不符时以非零退出码结束。

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
6. provide toolbox again
  + tool lookup_release
  + cache timer
  + cache map
  dependent state=2 (2=ACTIVE) tools=lookup_release
7. call one disposer twice
  disposer ran 1 time(s)
8. effect while the fiber is unloading
  state=5 (5=UNLOADING)
  Error: INACTIVE_EFFECT
9. async disposer yielded last in a generator effect
  bare-on: async disposer start, emit bare-on
  bare-on: async disposer end
  yield-on: async disposer start, emit yield-on
  listener still on: yield-on
  yield-on: async disposer end
10. two async effects on one fiber unload concurrently
  B(50ms) start
  A(10ms) start
  A(10ms) end
  B(50ms) end
11. dispose root
  - cache map
  - cache timer
  - tool lookup_release
```

实测基线：DeepSeek Harness `0.1.6-alpha.2`，commit `ddefc45fbc`（vendor Cordis `4.0.2`）；Node v22.22.0。
