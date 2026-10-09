/**
 * 按真实时间轮询，直到 check() 返回真值（或不抛错）。超时抛错，错误信息包含最后一次失败原因。
 * 用于等待真实 I/O（子进程、文件监听）。使用 fakeClock 的代码不要用它，用 clock.advanceAsync。
 */
export async function waitFor<T>(
  check: () => T | Promise<T>,
  o: { readonly timeoutMs?: number; readonly intervalMs?: number; readonly message?: string } = {},
): Promise<T> {
  const timeoutMs = o.timeoutMs ?? 5_000
  const intervalMs = o.intervalMs ?? 20
  const deadline = Date.now() + timeoutMs
  let last: unknown = null
  for (;;) {
    try {
      const value = await check()
      if (value !== false && value !== undefined && value !== null) return value
      last = `返回了 ${String(value)}`
    } catch (e) {
      last = e
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${o.message ?? 'waitFor 超时'}（${timeoutMs}ms）：${last instanceof Error ? last.message : String(last)}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
