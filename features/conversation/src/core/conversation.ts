import type {
  AgentEngine,
  ContextUsage,
  Controls,
  EngineSessionEvent,
  Interaction,
  QueueSnapshot,
  UsageSample,
} from '@poietica/engine'
import type { AttachmentsService } from '@poietica/feature-attachments/core-api'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import type { Clock, Logger } from '@poietica/foundation'
import type { Thread, TurnState } from '../contract/entities'
import { EventRouter } from './event-router'
import { createThreadsRepository } from './repository'
import { SessionPool } from './session-pool'
import { SubmissionService } from './submission-service'
import { createSubmissionsRepository } from './submissions-repository'
import { ThreadService } from './thread-service'
import type { TimelineHub } from './timeline-hub'
import { TurnService } from './turn-service'

export { OWNER_KEY } from './thread-service'

export interface ConversationCoreDeps {
  readonly db: Parameters<typeof createThreadsRepository>[0]
  readonly engine: AgentEngine
  readonly hub: TimelineHub
  readonly workspaces: WorkspacesService
  readonly attachments: AttachmentsService
  readonly clock: Clock
  readonly logger: Logger
  /** 线程状态变化 → threads.updated / turns.state */
  readonly emitThreadUpdated: (thread: Thread) => void
  readonly emitThreadRemoved: (threadId: string) => void
  readonly emitTurnState: (state: TurnState) => void
  readonly emitTurnDropped: (p: { threadId: string; clientTurnId: string | null; text: string }) => void
  readonly emitQueue: (p: { threadId: string; queue: QueueSnapshot }) => void
  readonly emitControls: (p: { threadId: string; controls: Controls }) => void
  /** 上下文用量单独报（见契约里 controls.contextChanged 的头注：它不搭控件那班车） */
  readonly emitContextUsage: (p: { threadId: string; usage: ContextUsage | null }) => void
  readonly emitInteractionRequested: (p: { threadId: string; interaction: Interaction }) => void
  readonly emitInteractionResolved: (p: { threadId: string; interactionId: string }) => void
  /** 「Core 即时回显」：提交行的两条通知（存库后推送） */
  readonly emitSubmissionChanged: (submission: import('../contract').SubmissionView) => void
  readonly emitSubmissionRemoved: (p: { threadId: string; clientTurnId: string }) => void
  /** Core 进程内事件（不走 RPC）：automations 与 usage 订阅它们 */
  readonly emitTurnSettled: (p: {
    threadId: string
    outcome: 'completed' | 'cancelled' | 'failed'
    error: { code: string; message: string } | null
  }) => void
  /** 一句话变成 failed 的广播（R-06）：automations 靠它收掉永远运行中的记录 */
  readonly emitSubmissionFailed: (p: {
    threadId: string
    clientTurnId: string
    deliverAs: 'turn' | 'steer' | 'followUp'
    error: { code: string; message: string }
  }) => void
  /** 线程被删除（R-06）：按线程索引的订阅方清账 */
  readonly emitThreadRemovedEvent: (p: { threadId: string }) => void
  readonly emitUsageSampled: (p: { threadId: string; sample: UsageSample; at: number }) => void
  /** 用户发出去一句话（准入）→ usage 的「消息数量」日账（ADR 0039） */
  readonly emitUserMessage: (p: { threadId: string; at: number }) => void
}

/**
 * conversation 的 Core 组合根（07 页 §5C 的文件清单）：
 *
 * - `thread-service.ts`  —— 线程 CRUD / fork / export / 删除 / 工作区级联
 * - `turn-service.ts`    —— submit / cancel / queue / controls / interactions / timeline
 * - `event-router.ts`    —— EngineSessionEvent → 通知 / Core 事件（含回合运行时）
 *
 * 这一层只做**接线**：把三份服务互相要用的口接起来（构造期全部走惰性闭包，见下）。
 * 三份服务以只读属性公开，`handlers.ts` / `conversation-service.ts` 直接调它们 ——
 * 早先每个契约方法都在这里再写一遍转发（约 40 个），每加一个能力要改两处、还容易
 * 漂移（R-08-7）。门面自己只留真正跨服务的编排（删除的遗忘钩子、`dispose`）和
 * 测试要用的那两个观察口。
 */
export class ConversationCore {
  private readonly pool: SessionPool
  private readonly router: EventRouter
  /** 线程 CRUD / fork / export / 级联删除 */
  readonly threads: ThreadService
  /** 回合、时间线、队列、控件、交互 */
  readonly turns: TurnService
  /** 提交行的账（存库、重试、丢弃、按页盖章） */
  readonly submissions: SubmissionService

  constructor(d: ConversationCoreDeps) {
    const repo = createThreadsRepository(d.db)
    const submissionsRepo = createSubmissionsRepository(d.db)

    /*
     * 三份服务互相引用（router 要读线程形状、pool 的 describe 要用 thread-service、
     * thread-service 又要问 pool 的状态），所以互相之间全部走**惰性闭包**：
     * 回调只在运行时才解开 `this.*`，构造期一条都不解引用。
     */
    this.threads = new ThreadService({
      repo,
      engine: d.engine,
      workspaces: d.workspaces,
      attachments: d.attachments,
      hub: d.hub,
      clock: d.clock,
      logger: d.logger,
      sessionState: (threadId) => this.pool.peek(threadId)?.state() ?? 'idle',
      peekSession: (threadId) => this.pool.peek(threadId),
      isOpening: (threadId) => this.pool.isOpening(threadId),
      releaseSession: (threadId) => this.pool.release(threadId),
      emitThreadUpdated: d.emitThreadUpdated,
      emitThreadRemoved: d.emitThreadRemoved,
      /* R-03 §2.3：线程删除的统一遗忘钩子 —— 按线程索引的进程内状态都在这里清理 */
      onThreadRemoved: (threadId) => {
        this.router.forget(threadId)
        this.submissions.forget(threadId)
        /* R-06：Core 事件版与 RPC 通知同源（钩子只有这一个发出点） */
        d.emitThreadRemovedEvent({ threadId })
      },
    })

    this.pool = new SessionPool({
      engine: d.engine,
      clock: d.clock,
      logger: d.logger,
      describe: (threadId) => this.threads.describe(threadId),
      onOpened: (threadId, session) => {
        this.threads.onOpened(threadId, session)
      },
      onEvent: (threadId, event) => {
        this.router.onEvent(threadId, event)
      },
      onReleased: (threadId) => {
        this.threads.onReleased(threadId)
      },
    })

    /*
     * 「Core 即时回显」：提交的存库、推送、后台交接都归它（方案第 4 节）。
     * 与 router 互相需要（router 要认领 clientTurnId、它要 pool 开会话），所以两边
     * 都走**惰性引用**：这里只把 this 上的实例交给 router，调用发生在运行时。
     */
    this.submissions = new SubmissionService({
      repo: submissionsRepo,
      workspaces: d.workspaces,
      attachments: d.attachments,
      clock: d.clock,
      logger: d.logger,
      requireThread: (threadId) => this.threads.requireRow(threadId),
      autoTitle: (threadId, text) => {
        this.threads.autoTitle(threadId, text)
      },
      emitChanged: d.emitSubmissionChanged,
      emitRemoved: d.emitSubmissionRemoved,
      emitFailed: d.emitSubmissionFailed,
      acquireSession: (threadId) => this.pool.acquire(threadId),
      emitUserMessage: d.emitUserMessage,
    })

    this.router = new EventRouter({
      repo,
      hub: d.hub,
      clock: d.clock,
      submissions: this.submissions,
      threads: {
        threadOf: (row) => this.threads.threadOf(row),
        setPosture: (threadId, posture) => {
          this.threads.setPosture(threadId, posture)
        },
      },
      emitThreadUpdated: d.emitThreadUpdated,
      emitTurnState: d.emitTurnState,
      emitTurnDropped: d.emitTurnDropped,
      emitQueue: d.emitQueue,
      emitControls: d.emitControls,
      emitContextUsage: d.emitContextUsage,
      emitInteractionRequested: d.emitInteractionRequested,
      emitInteractionResolved: d.emitInteractionResolved,
      emitTurnSettled: d.emitTurnSettled,
      emitUsageSampled: d.emitUsageSampled,
    })

    this.turns = new TurnService({
      engine: d.engine,
      repo,
      pool: this.pool,
      hub: d.hub,
      router: this.router,
      submissions: this.submissions,
      workspaces: d.workspaces,
      attachments: d.attachments,
      clock: d.clock,
      logger: d.logger,
      requireRow: (threadId) => this.threads.requireRow(threadId),
      threads: {
        threadOf: (row) => this.threads.threadOf(row),
        setPosture: (threadId, posture) => {
          this.threads.setPosture(threadId, posture)
        },
      },
      emitThreadUpdated: d.emitThreadUpdated,
      emitUserMessage: d.emitUserMessage,
    })

    /*
     * Core 启动时的提交恢复（方案第 4 节）：`pending` 与 `queued` 一律收成
     * `core_restarted` —— 前者是上一次进程没来得及交出去的，后者排在 omp 的内存队列里、
     * 跟着进程一起消失了（R-08-5）；`started` 里太旧的清掉（真实轮次在会话文件里，
     * 这里清的只是账）。
     */
    this.submissions.recoverOnStart()
  }

  /** 关停：会话池释放（门面自己留的编排之一） */
  async dispose(): Promise<void> {
    await this.pool.dispose()
  }

  /** 事件路由（会话池之外手动投递时用；单测可直接喂事件） */
  onEvent(threadId: string, event: EngineSessionEvent): void {
    this.router.onEvent(threadId, event)
  }

  /** 测试用：这条线程是否还有按线程索引的进程内状态（router + submissions） */
  hasThreadState(threadId: string): boolean {
    return this.router.has(threadId) || this.submissions.has(threadId)
  }
}
