import type { ContextUsage, Controls, EngineSessionEvent, Posture, QueueSnapshot, UsageSample } from '@poietica/engine'
import type { Clock } from '@poietica/foundation'
import type { TranscriptOperation } from '@poietica/transcript'
import type { Thread, TurnState } from '../contract/entities'
import { conversationErrors } from '../contract/errors'
import type { ThreadRow, ThreadsRepository } from './repository'
import type { TimelineHub } from './timeline-hub'

/**
 * 事件路由（07 页 §5C 的 `event-router.ts`）：把 `EngineSessionEvent` 变成通知 / Core 事件。
 *
 * 每一条线程的**回合运行时**也住在这里：它是「谁在跑、跑成什么、这一轮对应哪个 clientTurnId」
 * 的唯一一张表 —— `state` 事件正是更新它的那一个入口，而 submit / cancel 要往它里面写，
 * 所以两边共用这一份（07 页 §5C 的行为表）。
 */
interface Runtime {
  state: TurnState['state']
  error: { code: string; message: string } | null
  startedAt: number | null
  cancelRequested: boolean
  seenTurns: Set<string>
}

export interface EventRouterDeps {
  readonly repo: ThreadsRepository
  readonly hub: TimelineHub
  /**
   * 「Core 即时回显」的提交服务：路由要在本会话第一个新 turn 上盖 clientTurnId，
   * 并把那条提交推进到 `started`（方案第 4 节的「事件路由 timeline」一行）。
   */
  readonly submissions: import('./submission-service').SubmissionService
  readonly clock: Clock
  readonly threads: {
    threadOf(row: ThreadRow): Thread
    /** controls 事件里的姿态与线程行不一致时把行改掉（07 页 §5C 的行为表） */
    setPosture(threadId: string, posture: Posture): void
  }
  readonly emitThreadUpdated: (thread: Thread) => void
  readonly emitTurnState: (state: TurnState) => void
  readonly emitTurnDropped: (p: { threadId: string; clientTurnId: string | null; text: string }) => void
  readonly emitQueue: (p: { threadId: string; queue: QueueSnapshot }) => void
  readonly emitControls: (p: { threadId: string; controls: Controls }) => void
  readonly emitContextUsage: (p: { threadId: string; usage: ContextUsage | null }) => void
  readonly emitInteractionRequested: (p: {
    threadId: string
    interaction: import('@poietica/engine').Interaction
  }) => void
  readonly emitInteractionResolved: (p: { threadId: string; interactionId: string }) => void
  readonly emitTurnSettled: (p: {
    threadId: string
    outcome: 'completed' | 'cancelled' | 'failed'
    error: { code: string; message: string } | null
  }) => void
  readonly emitUsageSampled: (p: { threadId: string; sample: UsageSample; at: number }) => void
}

export class EventRouter {
  private readonly runtime = new Map<string, Runtime>()
  /**
   * 每条线程**已经认领过号**的 turnId。
   *
   * 与 `Runtime.seenTurns` 分开：那一份只在 state 事件之后才有，而认领必须在第一条
   * `turn.upsert` 到达时就发生（见 attributeClientTurn 的头注）。
   */
  private readonly claimed = new Map<string, Set<string>>()

  constructor(private readonly d: EventRouterDeps) {}

  // ── 回合运行时（submit / cancel 与 state 事件共用这一份）────────────────────
  /** cancel 打标记：轮到结束时 outcome 报 cancelled 而不是 completed */
  requestCancel(threadId: string): void {
    this.runtimeOf(threadId).cancelRequested = true
  }

  /** 线程被删：运行时一并丢掉 */
  forget(threadId: string): void {
    this.runtime.delete(threadId)
    this.claimed.delete(threadId)
  }

  /** 测试用：这条线程是否还有按线程索引的状态（回合运行时 / 认领表） */
  has(threadId: string): boolean {
    return this.runtime.has(threadId) || this.claimed.has(threadId)
  }

  // ── 路由（07 页 §5C 的行为表）─────────────────────────────────────────────
  onEvent(threadId: string, event: EngineSessionEvent): void {
    switch (event.type) {
      case 'timeline': {
        const ops = this.attributeClientTurn(threadId, event.ops)
        this.d.hub.push(threadId, event.agentId, ops)
        break
      }
      case 'timelineReset':
        this.d.hub.reset(threadId, event.agentId)
        break
      case 'state':
        this.onState(threadId, event.state, event.error)
        break
      case 'interactionRequested':
        this.d.emitInteractionRequested({ threadId, interaction: event.interaction })
        break
      case 'interactionResolved':
        this.d.emitInteractionResolved({ threadId, interactionId: event.interactionId })
        break
      case 'queue':
        this.d.emitQueue({ threadId, queue: event.queue })
        break
      case 'controls':
        this.d.emitControls({ threadId, controls: event.controls })
        if (event.controls.posture !== this.d.repo.get(threadId)?.posture)
          this.d.threads.setPosture(threadId, event.controls.posture)
        break
      case 'contextUsage':
        this.d.emitContextUsage({ threadId, usage: event.usage })
        break
      case 'usage':
        this.d.emitUsageSampled({ threadId, sample: event.usage, at: this.d.clock.now() })
        break
      case 'promptDropped':
        this.d.emitTurnDropped({ threadId, clientTurnId: null, text: event.text })
        break
    }
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────
  /**
   * 本会话第一个新 turn 上盖 clientTurnId（方案第 4 节「事件路由 timeline」一行）。
   *
   * 号从提交服务认领（只有**真的交给 omp 且还没开轮**的那条才有）；同时把那条提交推进
   * 到 `started` 并记下真实 `turnId` —— 界面就是靠这两样判断「真轮到了没」。
   */
  private attributeClientTurn(threadId: string, ops: readonly TranscriptOperation[]): readonly TranscriptOperation[] {
    return ops.map((op) => {
      if (op.op !== 'turn.upsert') return op
      const turnId = op.turn.turnId
      /*
       * 认领与 `runtime` 无关：runtime 只在 state 事件 / cancel 时才有，而「Core 即时
       * 回显」之后提交不再经过 router —— 依赖它的存在，号就永远认领不了（实测：提交
       * 一直是 pending，界面判不出「真轮到了没」，于是出现两个用户气泡）。
       */
      const claimedTurns = this.claimed.get(threadId) ?? new Set<string>()
      if (!claimedTurns.has(turnId)) {
        claimedTurns.add(turnId)
        this.claimed.set(threadId, claimedTurns)
        const claimed = this.d.submissions.claimPendingTurn(threadId)
        if (claimed !== null) this.d.submissions.markTurn(threadId, claimed, turnId)
      }
      /* 每条 upsert 都带上号（方案：实时推送和快照都要写上）：收尾那条会把整条 turn
         换掉，只在首条写号的话界面就判不出「真轮到了没」，提交行会再冒出来一条。 */
      const clientTurnId = this.d.submissions.clientTurnIdOf(threadId, turnId)
      return clientTurnId === null ? op : ({ ...op, turn: { ...op.turn, clientTurnId } } as TranscriptOperation)
    })
  }

  private runtimeOf(threadId: string): Runtime {
    let rt = this.runtime.get(threadId)
    if (rt === undefined) {
      rt = {
        state: 'idle',
        error: null,
        startedAt: null,
        cancelRequested: false,
        seenTurns: new Set(),
      }
      this.runtime.set(threadId, rt)
    }
    return rt
  }

  private onState(threadId: string, state: TurnState['state'], error: { code: string; message: string } | null): void {
    const rt = this.runtimeOf(threadId)
    const previous = rt.state
    rt.state = state
    rt.error = error
    if (state === 'running' && previous !== 'running' && previous !== 'awaiting') rt.startedAt = this.d.clock.now()
    this.d.emitTurnState({
      threadId,
      state,
      error,
      startedAt: state === 'idle' ? null : rt.startedAt,
    })
    const row = this.d.repo.get(threadId)
    if (row !== null) this.d.emitThreadUpdated(this.d.threads.threadOf(row))

    if ((previous === 'running' || previous === 'awaiting') && state === 'idle') {
      this.d.repo.update(threadId, { updatedAt: this.d.clock.now() })
      const outcome: 'completed' | 'cancelled' | 'failed' =
        error !== null ? 'failed' : rt.cancelRequested ? 'cancelled' : 'completed'
      rt.startedAt = null
      this.d.emitTurnSettled({ threadId, outcome, error })
      /*
       * 回到 idle 而那一轮**没开出来**（方案第 4 节）：交出去的那条提交还停在 pending，
       * 说明 omp 没收下它。按事件自带的 error 收成 failed；没有 error 时看是不是用户
       * 点了停止（cancelled），否则就是 dropped。
       */
      this.d.submissions.settleUnstarted(
        threadId,
        error ??
          (rt.cancelRequested
            ? { code: conversationErrors.submit_cancelled, message: conversationErrors.submit_cancelled }
            : { code: conversationErrors.submit_dropped, message: conversationErrors.submit_dropped }),
      )
      rt.cancelRequested = false
    }
  }
}
