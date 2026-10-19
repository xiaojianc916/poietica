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

/**
 * 线程表面用的 `open`：预热会话（`threads.open`），**同时主动问一次控件表**（审查 R-19-4）。
 *
 * `threads.open` 只预热、不返回控件表。点侧栏那条路（actions.openThread）一直会自己 refresh；
 * 但重启后由 navigation.restore 直接进到线程页的那条路只走这里 —— Core 就绪时那次 resyncVisible 与路由恢复并行，
 * 表面挂得晚就一份控件表都拿不到：输入框下面那排选择器（批准方式 / 模型 / 思考）不画，要点一下侧栏标题才出来（真实故障）。
 * 控件表的重复请求由 controls-store 按对话号合并，这里不必去重。
 */
export function createThreadSurfaceOpener(deps: {
  readonly open: (threadId: string) => Promise<unknown>
  readonly refreshControls: (threadId: string) => Promise<void>
}): (threadId: string) => Promise<unknown> {
  const { open, refreshControls } = deps
  return (threadId) => {
    const opened = open(threadId)
    void refreshControls(threadId).catch(() => undefined)
    return opened
  }
}

/**
 * 归档这一条时，当前页面要不要让位（回入口页）。
 *
 * 用户 2026-10-19：停在一个已归档的会话里是自相矛盾的 —— 侧栏上它已经不在了，主区却还开着它。
 * 归档**别的**对话时页面一动不动：那不是当前页面的消失，只是列表里少一行。
 *
 * 两个入参都是「当前页面正开着谁」与「要归档谁」；前者缺席（停在入口页 / 设置页）时不跳。
 */
export function leaveForArchive(activeThreadId: string | null, archivedThreadId: string): boolean {
  return activeThreadId !== null && activeThreadId === archivedThreadId
}
