import { Batcher, type Clock, systemClock } from '@poietica/foundation'

/**
 * 把 PTY 的高频小块输出合并为每 8ms 最多一条通知。
 *
 * 合批本身用 foundation 的 `Batcher`（它的注释点名的就是这个场景）；这里只补两件它不管的事：
 * ① `offset` 是这一段第一个码元在累计输出里的位置（R-08-15）—— 合批把几段拼在一起，只有起点能说明这段在
 * 整体里的位置；② **dispose 要丢弃而不是 flush**：`Batcher.dispose()` 会先把剩余条目交出去，而关终端
 * 那一刻的残渣没有收信人了（用 `closed` 把它挡掉）。
 */
export function createOutputBatcher(
  flush: (data: string, offset: number) => void,
  intervalMs = 8,
  clock: Clock = systemClock,
): { push(chunk: string): void; drain(): void; dispose(): void } {
  /** 累计推入的码元数。一段的起点 = 总量 − 这一段的长度。 */
  let total = 0
  let closed = false

  const batcher = new Batcher<string>({
    delayMs: intervalMs,
    clock,
    flush: (chunks) => {
      if (closed) return
      const data = chunks.join('')
      if (data.length === 0) return
      flush(data, total - data.length)
    },
  })

  return {
    push(chunk) {
      total += chunk.length
      batcher.push(chunk)
    },
    /* 退出前用它把最后几行排空，不等到期。 */
    drain() {
      batcher.flushNow()
    },
    dispose() {
      closed = true
      batcher.dispose()
    },
  }
}
