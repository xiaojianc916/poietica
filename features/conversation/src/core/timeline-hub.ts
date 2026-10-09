import type { Clock, Disposable } from '@poietica/foundation'
import type { TranscriptOperation } from '@poietica/transcript'
import { TimelineChannel } from './timeline-channel'

export interface TimelineOpsNotice {
  readonly threadId: string
  readonly agentId: string
  readonly epoch: number
  readonly seq: number
  readonly ops: readonly TranscriptOperation[]
}

export interface TimelineResetNotice {
  readonly threadId: string
  readonly agentId: string
  readonly epoch: number
}

export interface TimelineHubDeps {
  readonly clock: Clock
  readonly emitOps: (p: TimelineOpsNotice) => void
  readonly emitReset: (p: TimelineResetNotice) => void
}

/** (threadId, agentId) → TimelineChannel；epoch 是 Core 进程内的一个全局计数器 */
export class TimelineHub implements Disposable {
  private readonly channels = new Map<string, TimelineChannel>()
  private next = 1

  constructor(private readonly d: TimelineHubDeps) {}

  private key(threadId: string, agentId: string): string {
    return `${threadId}\u0000${agentId}`
  }

  private channel(threadId: string, agentId: string): TimelineChannel {
    const k = this.key(threadId, agentId)
    let c = this.channels.get(k)
    if (c === undefined) {
      c = new TimelineChannel(this.next++, () => this.next++, this.d.clock, {
        ops: (p) => this.d.emitOps({ threadId, agentId, ...p }),
        reset: (p) => this.d.emitReset({ threadId, agentId, ...p }),
      })
      this.channels.set(k, c)
    }
    return c
  }

  has(threadId: string, agentId: string): boolean {
    return this.channels.has(this.key(threadId, agentId))
  }

  push(threadId: string, agentId: string, ops: readonly TranscriptOperation[]): void {
    this.channel(threadId, agentId).push(ops)
  }

  reset(threadId: string, agentId: string): void {
    this.channel(threadId, agentId).reset()
  }

  position(threadId: string, agentId: string): { epoch: number; seq: number } {
    return this.channel(threadId, agentId).position()
  }

  catchUp(
    threadId: string,
    agentId: string,
    epoch: number,
    sinceSeq: number,
  ): { batches: { seq: number; ops: readonly TranscriptOperation[] }[]; latestSeq: number; complete: boolean } {
    const c = this.channels.get(this.key(threadId, agentId))
    if (c === undefined) return { batches: [], latestSeq: 0, complete: false }
    return c.catchUp(epoch, sinceSeq)
  }

  /** 会话被驱逐后又打开：该线程的所有通道换 epoch，UI 整页重取 */
  resetThread(threadId: string): void {
    for (const [k, c] of this.channels) {
      if (k.startsWith(`${threadId}\u0000`)) c.reset()
    }
  }

  /** 会话释放（空闲驱逐 / 配置换代）：丢掉该线程所有通道的补发历史，不通知 UI（R-05 §3.2） */
  dropHistory(threadId: string): void {
    for (const [k, c] of this.channels) {
      if (k.startsWith(`${threadId}\u0000`)) c.dropHistory()
    }
  }

  disposeThread(threadId: string): void {
    for (const [k, c] of [...this.channels]) {
      if (k.startsWith(`${threadId}\u0000`)) {
        c.dispose()
        this.channels.delete(k)
      }
    }
  }

  dispose(): void {
    for (const c of this.channels.values()) c.dispose()
    this.channels.clear()
  }
}
