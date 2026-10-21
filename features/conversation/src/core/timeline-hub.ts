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
  /**
   * 本进程 epoch 的起点；默认随机。测试注入固定值。
   *
   * epoch 是「换代」的判据（UI 按它给副本发 reset）；进程内自增只保证**本进程**不重复 ——
   * 两个先后启动的 Core 都从 1 开始，UI 就认不出换代（R-04 §3.2）。
   */
  readonly epochBase?: number
}

/** 2^40 以内的随机正整数：不用 `Date.now()`，同一毫秒启动的两个进程与时钟回拨都会撞号 */
export function randomEpochBase(): number {
  return 1 + Math.floor(Math.random() * 2 ** 40)
}

/** (threadId, agentId) → TimelineChannel；epoch 从随机起点自增，跨进程不重复 */
export class TimelineHub implements Disposable {
  private readonly channels = new Map<string, TimelineChannel>()
  private next: number

  constructor(private readonly d: TimelineHubDeps) {
    this.next = d.epochBase ?? randomEpochBase()
  }

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

  /**
   * 会话（重新）打开：该线程里**这一代发过增量**的通道换 epoch，UI 整页重取（会话被驱逐后又打开，订阅者手里的状态
   * 有一部分只活在旧会话的增量里，例如子代理行与后台作业）。
   *
   * 一条增量都没发过的通道不动：它的订阅者手里只有整页读出来的页 —— 池里没有会话时那是会话文件的冷读，而文件正是
   * 新会话的起点。换代只会让 UI 白白再整读一次（读写分离之后，「先冷读、后打开」是看历史对话的常态）。
   */
  resetAdvanced(threadId: string): void {
    for (const [k, c] of this.channels) {
      if (k.startsWith(`${threadId}\u0000`) && c.advanced()) c.reset()
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
