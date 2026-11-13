import type { AgentEvent } from '@poietica/agent-model'
import type { Clock, Disposable } from '@poietica/foundation'
import { StreamChannel } from '@poietica/stream-kit'

export {
  DEFAULT_BATCH_WINDOW_MS as BATCH_WINDOW_MS,
  DEFAULT_RING_CAPACITY as RING_CAPACITY,
  DEFAULT_RING_MAX_CHARS as RING_MAX_CHARS,
} from '@poietica/stream-kit'

/**
 * 运行中工具的中间结果最多多久发一次（P-05）。
 *
 * 通道只节流**中间结果**：工具第一次出现、以及完成 / 失败的那一份都立刻放行。
 * 批内合并、编号、环形缓存与补发交给 stream-kit（ADR-006）。
 */
export const TOOL_UPDATE_INTERVAL_MS = 100

export const frameKey = (frameId: string): string => `f\u0000${frameId}`

type ToolEvent = Extract<AgentEvent, { type: 'item.started' }>

export interface ChannelSink {
  events(p: { epoch: number; seq: number; events: readonly AgentEvent[] }): void
  reset(p: { epoch: number }): void
}

/** 一个 (threadId, agentId) 的增量通道：stream-kit 负责合批/编号/补发，这里只留时间线特有的工具节流。 */
export class TimelineChannel {
  private readonly stream: StreamChannel<AgentEvent>
  /** 正在跑、且已经发出过第一份的工具帧：之后的中间结果才节流（第一份必须立刻上屏） */
  private readonly running = new Set<string>()
  /** 压着没发的中间结果，每格只留最新一份；按第一次压下的顺序释放 */
  private readonly held = new Map<string, ToolEvent>()
  private heldTimer: Disposable | undefined

  constructor(
    epoch: number,
    nextEpoch: () => number,
    private readonly clock: Clock,
    private readonly sink: ChannelSink,
  ) {
    this.stream = new StreamChannel(epoch, nextEpoch, clock, {
      sink: {
        batch: (p) => sink.events({ epoch: p.epoch, seq: p.seq, events: p.items }),
        reset: (p) => sink.reset({ epoch: p.epoch }),
      },
      coalesce: coalesceDeltas,
    })
  }

  currentEpoch(): number {
    return this.stream.currentEpoch()
  }

  advanced(): boolean {
    return this.stream.advanced() || this.held.size > 0
  }

  push(events: readonly AgentEvent[]): void {
    if (events.length === 0) return
    const accepted: AgentEvent[] = []
    for (const event of events) {
      const kept = this.accept(event)
      if (kept !== undefined) accepted.push(kept)
    }
    this.stream.push(accepted)
  }

  flush(): void {
    this.releaseHeld()
    this.stream.flush()
  }

  position(): { epoch: number; seq: number } {
    this.flush()
    return this.stream.position()
  }

  catchUp(
    epoch: number,
    sinceSeq: number,
  ): { batches: { seq: number; events: readonly AgentEvent[] }[]; latestSeq: number; complete: boolean } {
    const caught = this.stream.catchUp(epoch, sinceSeq)
    return {
      batches: caught.batches.map((batch) => ({ seq: batch.seq, events: batch.items })),
      latestSeq: caught.latestSeq,
      complete: caught.complete,
    }
  }

  reset(): void {
    this.discardHeld()
    this.stream.reset()
  }

  dropHistory(): void {
    this.flush()
    this.stream.dropHistory()
  }

  dispose(): void {
    this.discardHeld()
    this.stream.dispose()
  }

  /** 一条事件的去向：进本批，或（运行中工具的中间结果）压到下一个节流点。 */
  private accept(event: AgentEvent): AgentEvent | undefined {
    if (event.type === 'item.removed') this.releaseHeld()
    if (event.type === 'item.started' && event.frame.kind === 'tool') {
      const key = frameKey(event.frame.frameId)
      if (event.frame.state === 'running' && this.running.has(key)) {
        this.held.set(key, event)
        this.heldTimer ??= this.clock.setTimeout(() => {
          this.releaseHeld()
          this.stream.flush()
        }, TOOL_UPDATE_INTERVAL_MS)
        return undefined
      }
      this.held.delete(key)
      if (event.frame.state === 'running') this.running.add(key)
      else this.running.delete(key)
    }
    if (event.type === 'item.completed' || event.type === 'item.failed') {
      const key = frameKey(event.frame.frameId)
      this.held.delete(key)
      this.running.delete(key)
    }
    return event
  }

  private releaseHeld(): void {
    this.heldTimer?.dispose()
    this.heldTimer = undefined
    if (this.held.size === 0) return
    this.stream.push([...this.held.values()])
    this.held.clear()
  }

  private discardHeld(): void {
    this.heldTimer?.dispose()
    this.heldTimer = undefined
    this.held.clear()
    this.running.clear()
  }
}

/** 紧邻、同格、同通道、offset 首尾相接的 delta 拼成一条；其余原样保留。 */
function coalesceDeltas(events: readonly AgentEvent[]): readonly AgentEvent[] {
  const out: AgentEvent[] = []
  for (const event of events) {
    const last = out.at(-1)
    if (
      event.type === 'item.delta' &&
      event.offset !== undefined &&
      event.text !== undefined &&
      last?.type === 'item.delta' &&
      last.frameId === event.frameId &&
      last.channel === event.channel &&
      last.offset !== undefined &&
      last.text !== undefined &&
      last.offset + last.text.length === event.offset
    ) {
      out[out.length - 1] = { ...last, text: last.text + event.text }
      continue
    }
    out.push(event)
  }
  return out
}
