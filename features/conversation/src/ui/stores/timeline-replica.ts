import {
  applyOps,
  oldestTurnId,
  prependOlder,
  stateFromPage,
  type TimelineState,
  TranscriptGapError,
  type TranscriptOperation,
} from '@poietica/transcript'
import type { ConversationApi } from '../api'

interface Batch {
  readonly epoch: number
  readonly seq: number
  readonly ops: readonly TranscriptOperation[]
}
export type ReplicaStatus = 'loading' | 'live' | 'error'

/**
 * 05 页 §12.2 的 UI 侧实现。不变式：
 * - 只在 status === 'live' 时应用增量；
 * - 只接受与当前 epoch 相同、且 seq === this.seq + 1 的批次；
 * - 任何无法弥补的不一致都通过 resubscribe() 整页重取。
 */
export class TimelineReplica {
  status: ReplicaStatus = 'loading'
  state: TimelineState | null = null
  private epoch = -1
  private seq = 0
  private buffer: Batch[] = []
  private generation = 0
  private catchingUp = false

  constructor(
    private readonly api: ConversationApi,
    readonly threadId: string,
    readonly agentId: string,
    private readonly onChange: () => void,
  ) {}

  async resubscribe(): Promise<void> {
    const gen = ++this.generation
    this.status = 'loading'
    this.buffer = []
    this.onChange()
    try {
      const snap = await this.api.subscribeTimeline(this.threadId, this.agentId)
      if (gen !== this.generation) return
      this.state = stateFromPage(snap.page)
      this.epoch = snap.epoch
      this.seq = snap.seq
      this.status = 'live'
      const buffered = this.buffer
      this.buffer = []
      for (const b of buffered) this.receive(b)
      this.onChange()
    } catch (e) {
      if (gen !== this.generation) return
      this.status = 'error'
      this.onChange()
      throw e
    }
  }

  receive(b: Batch): void {
    if (this.status === 'loading') {
      this.buffer.push(b)
      return
    }
    if (this.status !== 'live') return
    if (b.epoch !== this.epoch) {
      void this.resubscribe()
      return
    }
    if (b.seq <= this.seq) return
    if (b.seq !== this.seq + 1) {
      void this.catchUp()
      return
    }
    this.apply(b)
  }

  onReset(epoch: number): void {
    if (epoch !== this.epoch) void this.resubscribe()
  }

  /** 加载更早的轮次（滚动到顶部时） */
  async loadOlder(): Promise<void> {
    if (this.state === null || !this.state.hasMoreOlder) return
    const first = oldestTurnId(this.state)
    if (first === null) return
    const gen = this.generation
    const older = await this.api.timelinePage(this.threadId, this.agentId, first)
    if (gen !== this.generation || this.state === null) return // 期间重新订阅过：丢弃这页
    this.state = prependOlder(this.state, older)
    this.onChange()
  }

  dispose(): void {
    this.generation++
    this.status = 'error'
    void this.api.unsubscribeTimeline(this.threadId, this.agentId).catch(() => undefined)
  }

  private apply(b: Batch): void {
    try {
      this.state = applyOps(this.state!, b.ops)
      this.seq = b.seq
      this.onChange()
    } catch (e) {
      if (e instanceof TranscriptGapError) {
        void this.resubscribe()
        return
      }
      throw e
    }
  }

  private async catchUp(): Promise<void> {
    if (this.catchingUp) return
    this.catchingUp = true
    const gen = this.generation
    try {
      const r = await this.api.catchUp(this.threadId, this.agentId, this.epoch, this.seq)
      if (gen !== this.generation) return
      if (!r.complete) {
        void this.resubscribe()
        return
      }
      for (const b of r.batches) if (b.seq === this.seq + 1) this.apply({ epoch: this.epoch, seq: b.seq, ops: b.ops })
    } finally {
      this.catchingUp = false
    }
  }
}
