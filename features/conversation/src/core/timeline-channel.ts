import type { Clock, Disposable } from '@poietica/foundation'
import type { TranscriptOperation } from '@poietica/transcript'

export const BATCH_WINDOW_MS = 16
export const RING_CAPACITY = 2_000

export interface ChannelSink {
  ops(p: { epoch: number; seq: number; ops: readonly TranscriptOperation[] }): void
  reset(p: { epoch: number }): void
}

/** 一个 (threadId, agentId) 的增量通道：16ms 合批、编号、环形缓存最近 2000 批供补发 */
export class TimelineChannel {
  private seq = 0
  private pending: TranscriptOperation[] = []
  private timer: Disposable | undefined
  private readonly ring: { seq: number; ops: readonly TranscriptOperation[] }[] = []

  constructor(
    private epoch: number,
    private readonly nextEpoch: () => number,
    private readonly clock: Clock,
    private readonly sink: ChannelSink,
  ) {}

  /** 当前 epoch（订阅响应与 reset 通知都要它） */
  currentEpoch(): number {
    return this.epoch
  }

  push(ops: readonly TranscriptOperation[]): void {
    if (ops.length === 0) return
    this.pending.push(...ops)
    this.timer ??= this.clock.setTimeout(() => {
      this.flush()
    }, BATCH_WINDOW_MS)
  }

  flush(): void {
    this.timer?.dispose()
    this.timer = undefined
    if (this.pending.length === 0) return
    const batch = { seq: ++this.seq, ops: this.pending }
    this.pending = []
    this.ring.push(batch)
    if (this.ring.length > RING_CAPACITY) this.ring.shift()
    this.sink.ops({ epoch: this.epoch, seq: batch.seq, ops: batch.ops })
  }

  /** 无法用增量表达的变化（压缩、会话重新打开）：丢弃缓存、换新 epoch，通知 UI 重新订阅 */
  reset(): void {
    this.timer?.dispose()
    this.timer = undefined
    this.pending = []
    this.epoch = this.nextEpoch()
    this.seq = 0
    this.ring.length = 0
    this.sink.reset({ epoch: this.epoch })
  }

  /**
   * 只丢弃补发用的历史：不换 epoch、不重置 seq、不通知 UI（R-05 §3.2）。
   *
   * 会话被池子释放后这段环形缓存没有用处 —— 下次真的打开时会走 resetThread 换 epoch。
   * 之后的 catchUp 因缓存为空返回 complete:false，UI 整读；这里不能 reset，
   * 那会让 UI 立刻整读并 acquire 会话，刚驱逐就被重新打开。
   */
  dropHistory(): void {
    this.flush()
    this.ring.length = 0
  }

  /** 订阅时调用：先冲刷，返回当前位置；快照之后的批次 seq 一定大于这个值 */
  position(): { epoch: number; seq: number } {
    this.flush()
    return { epoch: this.epoch, seq: this.seq }
  }

  catchUp(
    epoch: number,
    sinceSeq: number,
  ): { batches: { seq: number; ops: readonly TranscriptOperation[] }[]; latestSeq: number; complete: boolean } {
    this.flush()
    if (epoch !== this.epoch) return { batches: [], latestSeq: this.seq, complete: false }
    const first = this.ring[0]
    if (sinceSeq < this.seq && (first === undefined || first.seq > sinceSeq + 1)) {
      return { batches: [], latestSeq: this.seq, complete: false }
    }
    return { batches: this.ring.filter((b) => b.seq > sinceSeq), latestSeq: this.seq, complete: true }
  }

  dispose(): void {
    this.timer?.dispose()
    this.timer = undefined
    this.pending = []
    this.ring.length = 0
  }
}
