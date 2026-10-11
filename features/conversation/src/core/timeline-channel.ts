import type { Clock, Disposable } from '@poietica/foundation'
import type { TranscriptOperation } from '@poietica/transcript'
import { compactOps, estimateChars, frameKey } from './timeline-compact'

export const BATCH_WINDOW_MS = 16
export const RING_CAPACITY = 2_000
/**
 * 运行中工具的中间结果最多多久发一次（P-05）。
 *
 * omp 每收到一块输出就把「到目前为止的尾部输出（≤50KB）」整份报一次，快的命令每秒上百次；
 * 人眼看滚动输出 10 次/秒已经足够。只节流**中间结果**：工具第一次出现、以及完成 / 失败的
 * 那一份都立刻放行。
 */
export const TOOL_UPDATE_INTERVAL_MS = 100
/** 环形缓存的字符预算（约 16MB UTF-16）：按批数限不住「每批都带一份大输出」的情况 */
export const RING_MAX_CHARS = 8_000_000

type FrameUpsertOp = Extract<TranscriptOperation, { op: 'frame.upsert' }>

interface RingBatch {
  readonly seq: number
  readonly ops: readonly TranscriptOperation[]
  readonly chars: number
}

export interface ChannelSink {
  ops(p: { epoch: number; seq: number; ops: readonly TranscriptOperation[] }): void
  reset(p: { epoch: number }): void
}

/** 一个 (threadId, agentId) 的增量通道：16ms 合批、批内压缩、编号、环形缓存最近的批次供补发 */
export class TimelineChannel {
  private seq = 0
  private pending: TranscriptOperation[] = []
  private timer: Disposable | undefined
  private readonly ring: RingBatch[] = []
  private ringChars = 0
  /** 正在跑、且已经发出过第一份的工具帧：之后的中间结果才节流（第一份必须立刻上屏） */
  private readonly running = new Set<string>()
  /** 压着没发的中间结果，每格只留最新一份；按第一次压下的顺序释放 */
  private readonly held = new Map<string, FrameUpsertOp>()
  private heldTimer: Disposable | undefined

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
    for (const op of ops) this.accept(op)
    if (this.pending.length === 0) return
    this.timer ??= this.clock.setTimeout(() => {
      this.emit()
    }, BATCH_WINDOW_MS)
  }

  /** 冲刷：压着的中间结果一并发出。订阅快照、补发、丢历史之前都要看到最新状态 */
  flush(): void {
    this.releaseHeld()
    this.emit()
  }

  /*
   * 一条 op 的去向：进本批，或（运行中工具的中间结果）压到下一个节流点。
   *
   * 压下的 op 被挪到后面的批次里，等于和它之后到的 op 交换了先后。只有不碰那一格的 op
   * 才能交换：reset / items.remove 之前先把压着的放出去；同一格的终态到达时，压着的那份
   * 直接作废 —— 否则它会在终态之后才被放出，把「已完成」盖回「运行中」。
   */
  private accept(op: TranscriptOperation): void {
    if (op.op === 'reset' || op.op === 'items.remove') {
      this.releaseHeld()
      if (op.op === 'reset') this.running.clear()
    }
    if (op.op === 'frame.upsert' && op.frame.kind === 'tool') {
      const key = frameKey(op.turnId, op.stepId, op.frame.frameId)
      if (op.frame.state === 'running' && this.running.has(key)) {
        this.held.set(key, op)
        this.heldTimer ??= this.clock.setTimeout(() => {
          this.releaseHeld()
          this.emit()
        }, TOOL_UPDATE_INTERVAL_MS)
        return
      }
      this.held.delete(key)
      if (op.frame.state === 'running') this.running.add(key)
      else this.running.delete(key)
    }
    this.pending.push(op)
  }

  private releaseHeld(): void {
    this.heldTimer?.dispose()
    this.heldTimer = undefined
    if (this.held.size === 0) return
    for (const op of this.held.values()) this.pending.push(op)
    this.held.clear()
  }

  /** 发出本批：压缩 → 编号 → 入环（按批数与字符预算裁旧）→ 通知 */
  private emit(): void {
    this.timer?.dispose()
    this.timer = undefined
    if (this.pending.length === 0) return
    const ops = compactOps(this.pending)
    this.pending = []
    const batch: RingBatch = { seq: ++this.seq, ops, chars: estimateChars(ops) }
    this.ring.push(batch)
    this.ringChars += batch.chars
    /* 至少留最新一批：单批超预算时，补发仍能接上最近的位置 */
    while (this.ring.length > RING_CAPACITY || (this.ringChars > RING_MAX_CHARS && this.ring.length > 1)) {
      this.ringChars -= this.ring.shift()?.chars ?? 0
    }
    this.sink.ops({ epoch: this.epoch, seq: batch.seq, ops: batch.ops })
  }

  /** 无法用增量表达的变化（压缩、会话重新打开）：丢弃缓存、换新 epoch，通知 UI 重新订阅 */
  reset(): void {
    this.discard()
    this.epoch = this.nextEpoch()
    this.seq = 0
    this.sink.reset({ epoch: this.epoch })
  }

  /** 丢掉一切未发与已缓存的：新 epoch 的 UI 会整读，压着的中间结果也不必再发 */
  private discard(): void {
    this.timer?.dispose()
    this.timer = undefined
    this.heldTimer?.dispose()
    this.heldTimer = undefined
    this.pending = []
    this.held.clear()
    this.running.clear()
    this.ring.length = 0
    this.ringChars = 0
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
    this.ringChars = 0
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
    const batches = this.ring.filter((b) => b.seq > sinceSeq).map(({ seq, ops }) => ({ seq, ops }))
    return { batches, latestSeq: this.seq, complete: true }
  }

  dispose(): void {
    this.discard()
  }
}
