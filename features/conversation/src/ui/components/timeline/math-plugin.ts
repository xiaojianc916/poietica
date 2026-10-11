import type { PluginConfig } from 'streamdown'

type MathPlugin = NonNullable<PluginConfig['math']>

/*
 * 公式渲染按需加载（性能审查 P-06）。
 *
 * katex 约 500KB，以前由 prose.tsx 静态导入、进了入口闭包：每次启动都要解析编译，哪怕这次
 * 一条公式都不出现。现在它在独立分块里，两条路触发加载（都只加载一次）：
 *   - 会话功能第一次 onCoreReady 时预取（index.tsx）：历史记录里的公式通常赶得上第一次绘制；
 *   - 某段正文里出现 `$` 而模块还没到（prose.tsx 的 useProsePlugins）。
 * 模块到达之前，含公式的正文先按普通文本显示，到达后同一批 Prose 换上带 math 的插件表重绘一次。
 */
let plugin: MathPlugin | undefined
let pending: Promise<MathPlugin> | undefined
let generation = 0
const listeners = new Set<() => void>()

/** 加载并缓存；失败时清掉 pending，下一次触发会重试（正文保持源码显示，不报错打断阅读） */
export function loadMath(): Promise<MathPlugin> {
  const at = generation
  pending ??= Promise.all([import('@streamdown/math'), import('katex/dist/katex.min.css')]).then(
    ([module]) => {
      /* 单美元号按公式处理；成对货币符号也可能被识别为公式。 */
      const created = module.createMathPlugin({ singleDollarTextMath: true })
      /* 复位之后晚到的结果作废，不把清过的状态写回来（见 resetMathForTests） */
      if (at !== generation) return created
      plugin = created
      for (const listener of listeners) listener()
      return plugin
    },
    (cause: unknown) => {
      /* 复位之后晚到的失败同样作废：别把新一代的 pending 清掉 */
      if (at === generation) pending = undefined
      throw cause
    },
  )
  return pending
}

/** useSyncExternalStore 的读口：没到达时是 undefined */
export const currentMath = (): MathPlugin | undefined => plugin

/** useSyncExternalStore 的订阅口；退订即删除，集合不会随组件挂卸增长 */
export function subscribeMath(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** remark-math 只认 `$` 定界（单 / 双美元号）；没有 `$` 的正文用不上公式插件 */
export const mayContainMath = (text: string): boolean => text.includes('$')

/*
 * 测试用复位：bun test 的多个测试文件共享同一份模块实例，别的文件先启动过整个功能
 * （一次 onCoreReady 预取）就会让 M1「没有 `$` 就不加载」看见脏状态。
 */
export function resetMathForTests(): void {
  generation += 1
  plugin = undefined
  pending = undefined
  listeners.clear()
}
