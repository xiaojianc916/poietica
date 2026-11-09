import type { Clock, Disposable } from '@poietica/foundation'
import { randomEpochBase, StreamChannel } from '@poietica/stream-kit'

export interface SideDelta {
  readonly threadId: string
  readonly topicId: string
  readonly turn: number
  readonly offset: number
  readonly delta: string
}

export interface SideDeltaNotice extends SideDelta {
  readonly epoch: number
  readonly seq: number
}

export interface SideCatchUp {
  readonly batches: readonly { seq: number; turn: number; offset: number; delta: string }[]
  readonly latestSeq: number
  readonly complete: boolean
}

interface HubDeps {
  readonly clock: Clock
  readonly emit: (p: SideDeltaNotice) => void
  readonly epochBase?: number
}

/** 侧边提问的增量通道：与时间线共用 stream-kit 的批次、epoch/seq 与补发语义。 */
export class SideTopicHub implements Disposable {
  private readonly channels = new Map<string, StreamChannel<SideDelta>>()
  private next: number

  constructor(private readonly d: HubDeps) {
    this.next = d.epochBase ?? randomEpochBase()
  }

  private channel(threadId: string, topicId: string): StreamChannel<SideDelta> {
    const key = `${threadId}\u0000${topicId}`
    let channel = this.channels.get(key)
    if (channel === undefined) {
      channel = new StreamChannel(this.next++, () => this.next++, this.d.clock, {
        batchWindowMs: 16,
        sizeOf: (items) => items.reduce((sum, item) => sum + item.delta.length, 0),
        sink: {
          batch: ({ epoch, seq, items }) => {
            const data = items.map((item) => item.delta).join('')
            const first = items[0]
            const last = items.at(-1)
            if (data === '' || first === undefined || last === undefined) return
            this.d.emit({ ...first, delta: data, epoch, seq, turn: last.turn })
          },
          reset: () => undefined,
        },
      })
      this.channels.set(key, channel)
    }
    return channel
  }

  push(delta: SideDelta): void {
    this.channel(delta.threadId, delta.topicId).push([delta])
  }

  catchUp(threadId: string, topicId: string, epoch: number, sinceSeq: number): SideCatchUp {
    const result = this.channel(threadId, topicId).catchUp(epoch, sinceSeq)
    return {
      batches: result.batches.map((batch) => {
        const first = batch.items[0]
        const last = batch.items.at(-1)
        return {
          seq: batch.seq,
          turn: last?.turn ?? 0,
          offset: first?.offset ?? 0,
          delta: batch.items.map((item) => item.delta).join(''),
        }
      }),
      latestSeq: result.latestSeq,
      complete: result.complete,
    }
  }

  dispose(): void {
    for (const channel of this.channels.values()) channel.dispose()
    this.channels.clear()
  }
}
