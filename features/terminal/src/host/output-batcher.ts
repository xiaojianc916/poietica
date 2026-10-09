/** 把 PTY 的高频小块输出合并为每 8ms 最多一条通知 */
export function createOutputBatcher(
  flush: (data: string) => void,
  intervalMs = 8,
): { push(chunk: string): void; drain(): void; dispose(): void } {
  let buf = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const fire = (): void => {
    timer = undefined
    if (buf.length > 0) {
      const d = buf
      buf = ''
      flush(d)
    }
  }
  return {
    push(chunk) {
      buf += chunk
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
