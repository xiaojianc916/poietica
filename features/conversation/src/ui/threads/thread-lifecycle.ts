import { useEffect, useRef } from 'react'

/**
 * 挂载 → `threads.open`（后台预热，幂等）；卸载 → `threads.close`（忙则什么也不做）。卸载要**推迟一拍**：
 * StrictMode 会把每个 effect「挂载 → 清理 → 再挂载」，直接发 `threads.close` 会把刚预热的会话立刻释放。推迟到下一个宏任务、并在同一线程再次挂载时取消 —— 双渲染净效果是零。
 */
export function useThreadSessionLifecycle(deps: {
  readonly threadId: string
  readonly open: (threadId: string) => Promise<unknown>
  readonly close: (threadId: string) => Promise<void>
}): void {
  const { close, open, threadId } = deps
  const pending = useRef<{ threadId: string; timer: ReturnType<typeof setTimeout> } | null>(null)

  useEffect(() => {
    if (threadId === '') return
    const scheduled = pending.current
    if (scheduled !== null && scheduled.threadId === threadId) {
      clearTimeout(scheduled.timer)
      pending.current = null
    }
    void open(threadId).catch(() => undefined)
    return () => {
      const timer = setTimeout(() => {
        pending.current = null
        void close(threadId).catch(() => undefined)
      }, 0)
      pending.current = { threadId, timer }
    }
  }, [close, open, threadId])
}
