import type { Clock, Disposable } from '@poietica/foundation'

/*
 * 流原语（ADR-006）：快照 + 增量 + epoch + seq + 补齐 + 环形缓冲。
 *
 * 时间线、终端、浏览器标签最终都共用这一套语义；上层只提供「怎么合并一批元素」和
 * 「一批元素有多大」，不各自再写一套编号与补发。服务端每次失忆都换 epoch，客户端带
 * epoch/seq 订阅；序号断档且环形缓冲够不着时交回 complete:false，让客户端重取快照。
 */

export interface StreamBatch<T> {
  readonly seq: number
  readonly items: readonly T[]
}

export interface StreamSink<T> {
  batch(p: { readonly epoch: number; readonly seq: number; readonly items: readonly T[] }): void
  reset(p: { readonly epoch: number }): void
}

export interface StreamChannelOptions<T> {
  readonly sink: StreamSink<T>
  readonly batchWindowMs?: number
  readonly ringCapacity?: number
  readonly maxChars?: number
  /** 批内合并；默认原样保留。只做可证明等价的合并。 */
  readonly coalesce?: (pending: readonly T[]) => readonly T[]
  /** 一批元素的体积估算；默认 JSON 序列化长度 */
  readonly sizeOf?: (items: readonly T[]) => number
}

interface RingEntry<T> {
  readonly seq: number
  readonly items: readonly T[]
  readonly chars: number
}

export const DEFAULT_BATCH_WINDOW_MS = 16
export const DEFAULT_RING_CAPACITY = 2_000
export const DEFAULT_RING_MAX_CHARS = 8_000_000

export class StreamChannel<T> implements Disposable {
  private seq = 0
  private pending: T[] = []
  private timer: Disposable | undefined
  private readonly ring: RingEntry<T>[] = []
  private ringChars = 0
  private readonly batchWindowMs: number
  private readonly ringCapacity: number
  private readonly maxChars: number
  private readonly sizeOf: (items: readonly T[]) => number
  private readonly coalesce: (pending: readonly T[]) => readonly T[]
  private readonly sink: StreamSink<T>

  constructor(
    private epoch: number,
    private readonly nextEpoch: () => number,
    private readonly clock: Clock,
    options: StreamChannelOptions<T>,
  ) {
    this.sink = options.sink
    this.batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS
    this.ringCapacity = options.ringCapacity ?? DEFAULT_RING_CAPACITY
    this.maxChars = options.maxChars ?? DEFAULT_RING_MAX_CHARS
    this.sizeOf = options.sizeOf ?? ((items) => JSON.stringify(items).length)
    this.coalesce = options.coalesce ?? ((items) => items)
  }

  currentEpoch(): number {
    return this.epoch
  }

  /** 这一代有没有发过（或正压着）增量；没有时重新打开不必换代 */
  advanced(): boolean {
    return this.seq > 0 || this.pending.length > 0
  }

  push(items: readonly T[]): void {
    if (items.length === 0) return
    this.pending.push(...items)
    this.timer ??= this.clock.setTimeout(() => {
      this.emit()
    }, this.batchWindowMs)
  }

  /** 冲刷：订阅快照、补发、丢历史之前都要看到最新状态 */
  flush(): void {
    this.emit()
  }

  position(): { readonly epoch: number; readonly seq: number } {
    this.flush()
    return { epoch: this.epoch, seq: this.seq }
  }

  catchUp(
    epoch: number,
    sinceSeq: number,
  ): {
    readonly batches: readonly StreamBatch<T>[]
    readonly latestSeq: number
    readonly complete: boolean
  } {
    this.flush()
    if (epoch !== this.epoch) return { batches: [], latestSeq: this.seq, complete: false }
    const first = this.ring[0]
    if (sinceSeq < this.seq && (first === undefined || first.seq > sinceSeq + 1)) {
      return { batches: [], latestSeq: this.seq, complete: false }
    }
    return {
      batches: this.ring.filter((entry) => entry.seq > sinceSeq).map(({ seq, items }) => ({ seq, items })),
      latestSeq: this.seq,
      complete: true,
    }
  }

  /** 失忆：丢掉缓存、换新 epoch，通知客户端重新订阅 */
  reset(): void {
    this.discard()
    this.epoch = this.nextEpoch()
    this.seq = 0
    this.sink.reset({ epoch: this.epoch })
  }

  /** 只丢补发历史：不换 epoch、不重置 seq、不通知客户端 */
  dropHistory(): void {
    this.flush()
    this.ring.length = 0
    this.ringChars = 0
  }

  dispose(): void {
    this.discard()
  }

  private emit(): void {
    this.timer?.dispose()
    this.timer = undefined
    if (this.pending.length === 0) return
    const items = this.coalesce(this.pending)
    this.pending = []
    const entry: RingEntry<T> = { seq: ++this.seq, items, chars: this.sizeOf(items) }
    this.ring.push(entry)
    this.ringChars += entry.chars
    while (this.ring.length > this.ringCapacity || (this.ringChars > this.maxChars && this.ring.length > 1)) {
      this.ringChars -= this.ring.shift()?.chars ?? 0
    }
    this.sink.batch({ epoch: this.epoch, seq: entry.seq, items: entry.items })
  }

  private discard(): void {
    this.timer?.dispose()
    this.timer = undefined
    this.pending = []
    this.ring.length = 0
    this.ringChars = 0
  }
}

/** 2^40 以内的随机正整数：进程间 epoch 起点，不靠时钟。 */
export function randomEpochBase(): number {
  return 1 + Math.floor(Math.random() * 2 ** 40)
}
