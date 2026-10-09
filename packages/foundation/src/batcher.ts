import type { Clock } from './clock'
import type { Disposable } from './disposable'

/**
 * 合并器：push 进来的条目在 delayMs 内攒成一批，再一次性交给 flush。
 * maxItems 达到上限时立即 flush。dispose 会先把剩余条目 flush 掉。
 * 用于高频通知（例如 usage.updated 每秒最多一次、终端输出 8ms 合并）。
 */
export class Batcher<T> implements Disposable {
  private items: T[] = []
  private timer: Disposable | undefined
  private disposed = false

  constructor(
    private readonly o: {
      readonly delayMs: number
      readonly flush: (items: T[]) => void
      readonly clock: Clock
      readonly maxItems?: number
    },
  ) {}

  push(item: T): void {
    if (this.disposed) return
    this.items.push(item)
    if (this.o.maxItems !== undefined && this.items.length >= this.o.maxItems) {
      this.flushNow()
      return
    }
    this.timer ??= this.o.clock.setTimeout(() => {
      this.timer = undefined
      this.flushNow()
    }, this.o.delayMs)
  }

  flushNow(): void {
    this.timer?.dispose()
    this.timer = undefined
    if (this.items.length === 0) return
    const batch = this.items
    this.items = []
    this.o.flush(batch)
  }

  dispose(): void {
    if (this.disposed) return
    this.flushNow()
    this.disposed = true
  }
}
