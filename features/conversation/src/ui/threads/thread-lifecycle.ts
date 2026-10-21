import { useCallback, useEffect, useRef } from 'react'

/**
 * 一条对话表面的会话生命周期 —— **按意图打开**（性能方案 P4）：看对话不开会话，开始写才开。
 *
 * - 挂载 / 换对话：只问一次控件表（审查 R-19-4：重启后由 navigation.restore 直接进到线程页时没有人点侧栏，表面自己不问，
 *   输入框下面那排选择器就不画）。没开着的会话由 Core 冷读作答（控件表快照），不为一次读去打开会话；
 * - 人开始写（输入框拿到焦点、拖进文件）：交回的 `engage` → `threads.open` 后台预热，每条对话每次挂载只发一次 ——
 *   第一句话发出去时会话已经开好；只是看一眼就走，什么都不开、会话文件一个字节都不动；
 * - 卸载：`threads.close`（忙则什么也不做）。要**推迟一拍**：StrictMode 会把每个 effect「挂载 → 清理 → 再挂载」，
 *   直接发会把刚预热的会话立刻释放。推迟到下一个宏任务、并在同一线程再次挂载时取消 —— 双渲染净效果是零。
 *
 * 控件表的重复请求由 controls-store 按对话号合并，这里不必去重；会话打开后的真值由 Core 推（controls.changed）。
 */
export function useThreadSessionLifecycle(deps: {
  readonly threadId: string
  readonly open: (threadId: string) => Promise<unknown>
  readonly close: (threadId: string) => Promise<void>
  readonly refreshControls: (threadId: string) => Promise<void>
}): () => void {
  const { close, open, refreshControls, threadId } = deps
  const pending = useRef<{ threadId: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  /* 这一次挂载已经为哪条对话发过预热：同一条只发一次，换了对话重新算 */
  const engaged = useRef<string | null>(null)

  useEffect(() => {
    if (threadId === '') return
    const scheduled = pending.current
    if (scheduled !== null && scheduled.threadId === threadId) {
      clearTimeout(scheduled.timer)
      pending.current = null
    }
    void refreshControls(threadId).catch(() => undefined)
    return () => {
      if (engaged.current === threadId) engaged.current = null
      const timer = setTimeout(() => {
        pending.current = null
        void close(threadId).catch(() => undefined)
      }, 0)
      pending.current = { threadId, timer }
    }
  }, [close, refreshControls, threadId])

  return useCallback(() => {
    if (threadId === '' || engaged.current === threadId) return
    engaged.current = threadId
    void open(threadId).catch(() => undefined)
  }, [open, threadId])
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
