# engine-runtime（吉祥物引擎）

对话页吉祥物的运行时：几何数据 / 渲染 / 驱动三层，由上游 emotion-ball 的四个
IIFE 脚本（`rings.js` / `emotions.js` / `ball.js` / `engine.js`）逐字迁入并类型化。

## 文件

| 文件                       | 说明                                                 |
| -------------------------- | ---------------------------------------------------- |
| [rings.ts](rings.ts)       | 几何数据层：眼环轮廓、身体形状。数据本体未改         |
| [emotions.ts](emotions.ts) | 表情配置层：4 组 32 套表情。数据本体未改             |
| [ball.ts](ball.ts)         | 渲染层：SVG 构建、球面投影、彩带 / 撒花 / zzz        |
| [engine.ts](engine.ts)     | 驱动层：配置注册中心、rAF 状态机、动画原语、待机策略 |
| [types.ts](types.ts)       | 三层之间的共享类型（pose 形状等）                    |

## 消费方

只有 [../emotion-ball-runtime.ts](../emotion-ball-runtime.ts)：它把引擎收窄成
`EmotionBallRuntime`，组件 [../emotion-ball.tsx](../emotion-ball.tsx) 只认那个窄接口。
要加新能力，先扩窄接口，别让组件直接 import 这里。

## 迁移口径

算法、数值、绘制顺序**未改**；只做了三件事：IIFE 拆成 ES 模块、`window` 全局改 import、
`console.*` 改为注入 logger。

等价性是实测的，不是推断：迁移时把上游原始 `.js` 与迁移后的 `.ts` 放进同一 happy-dom、
固定随机数与时钟，比对 **32 套表情 × 3 种形状**连续切表情 + 自旋 + 注视的逐帧 SVG，以及
`config.exportConfig()` 与分组列表，**逐字节一致**。结论冻结在
[`../__tests__/mascot-baseline.test.ts`](../__tests__/mascot-baseline.test.ts)。

## 两条规则例外

[biome.json](../../../../../../../biome.json) 对这个目录有两个精确到文件的例外，原因见
[refactor-log](../../../../../../../docs/refactor-log.md) 的 V-01：

1. `noInnerDeclarations` 关闭：上游用 `var` 的函数作用域在同一个函数里共享同名变量
   （`e` / `a` / `r` 等 15 组重复声明），机械改成 `let` 会直接冲突或改变语义。
2. `noExcessiveCognitiveComplexity` 上限提到 80：上游把构建、投影、彩带、撒花写在
   一个 `createBall` / `applyPose` 里（最高 79）。拆函数要动渲染顺序，属于重写，
   不在「逐字迁移」范围内。

**改这个目录时请守住**：要么保持逐字等价并跑基线测试，要么明确按重写处理（那时应该
把例外一并收回）。
