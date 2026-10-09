/**
 * 把 PTY 的高频小块输出合并为每 8ms 最多一条通知。
 *
 * `flush(data, offset)` 的 offset 是本段第一个码元在终端累计输出里的位置（R-08-15）：
 * 合批把几段拼在一起，只有起点能说明这段在整体里的位置。
 */
export function createOutputBatcher(
  flush: (data: string, offset: number) => void,
  intervalMs = 8,
): { push(chunk: string): void; drain(): void; dispose(): void } {
  let buf = ''
  /* 缓冲区里第一个码元的位置；合批与丢弃都不影响累计计数 */
  let base = 0
  let total = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const fire = (): void => {
    timer = undefined
    if (buf.length > 0) {
      const d = buf
      const offset = base
      buf = ''
      flush(d, offset)
    }
  }
  return {
    push(chunk) {
      if (buf.length === 0) base = total
      buf += chunk
      total += chunk.length
      if (timer === undefined) timer = setTimeout(fire, intervalMs)
    },
    drain() {
      if (timer !== undefined) clearTimeout(timer)
      fire()
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      buf = ''
    },
  }
}
