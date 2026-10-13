import type { PluginConfig } from 'streamdown'

type MathPlugin = NonNullable<PluginConfig['math']>

/* katex 约 500KB，静态导入会进入口闭包、每次启动都要解析编译（性能审查 P-06）：现在在独立分块里，
   由会话首次 onCoreReady 预取（index.tsx）或正文出现 `$` 而模块未到时触发；模块到达前按普通文本显示。 */
let plugin: MathPlugin | undefined
let pending: Promise<MathPlugin> | undefined
let generation = 0
const listeners = new Set<() => void>()

/** 失败时清掉 pending 让下次触发重试（正文保持源码显示，不报错打断阅读） */
export function loadMath(): Promise<MathPlugin> {
  const at = generation
  pending ??= Promise.all([import('@streamdown/math'), import('katex/dist/katex.min.css')]).then(
    ([module]) => {
      /* 单美元号也按公式处理：成对的货币符号可能被误认成公式。 */
      const created = module.createMathPlugin({ singleDollarTextMath: true })
      /* 复位后晚到的结果作废，不把清过的状态写回来。 */
      if (at !== generation) return created
      plugin = created
      for (const listener of listeners) listener()
      return plugin
    },
    (cause: unknown) => {
      /* 复位后晚到的失败同样作废：别把新一代的 pending 清掉。 */
      if (at === generation) pending = undefined
      throw cause
    },
  )
  return pending
}

/** useSyncExternalStore 的读口：没到达时是 undefined */
export const currentMath = (): MathPlugin | undefined => plugin

/** 退订即删除：集合不随组件挂卸增长。 */
export function subscribeMath(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 只在文本含 `$` 时才可能用上公式插件（remark-math 只认 `$` 定界）。 */
export const mayContainMath = (text: string): boolean => text.includes('$')

/* 测试用复位：bun test 各测试文件共享同一份模块实例，别的文件先启动过整个功能（一次 onCoreReady 预取）
   会让 M1「没有 `$` 就不加载」看见脏状态。 */
export function resetMathForTests(): void {
  generation += 1
  plugin = undefined
  pending = undefined
  listeners.clear()
}
