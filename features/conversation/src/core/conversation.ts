import type { AttachmentsService } from '@poietica/feature-attachments/core-api'
import type { CheckpointService } from '@poietica/feature-checkpoints/core-api'
import type { JournalService } from '@poietica/feature-journal/core-api'
import type {
  CreateSessionPool,
  SessionPool,
  SubmissionService,
  SubmissionWriteLeasePort,
  TurnContextRegistry,
  TurnService,
} from '@poietica/feature-runs/core-api'
import type { ThreadRow, ThreadsRepository, ThreadsService } from '@poietica/feature-threads/core-api'
import type { CreateEventRouter, EventRouter, TimelineService } from '@poietica/feature-timeline/core-api'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import type { Clock, Logger } from '@poietica/foundation'
import type {
  CommandOutputTone,
  ContextUsage,
  Controls,
  EngineSessionEvent,
  FileChange,
  Interaction,
  SideTopic,
  UsageSample,
} from '@poietica/runtime-protocol'
import type { ModuleDatabase } from '@poietica/storage-sqlite'
import type { QueueView, Thread, TurnState } from '../contract/entities'
import type { ConversationRuntime } from './runtime'
import type { SideDelta } from './side-topic-hub'

export interface ConversationCoreDeps {
  readonly db: ModuleDatabase
  readonly repo: ThreadsRepository
  readonly threads: ThreadsService
  readonly createSessionPool: CreateSessionPool
  readonly submissionsService: SubmissionService
  readonly turnService: TurnService
  readonly createEventRouter: CreateEventRouter
  readonly runtime: ConversationRuntime
  readonly journal: JournalService
  readonly checkpoints?: CheckpointService
  readonly hub: TimelineService
  readonly workspaces: WorkspacesService
  readonly attachments: AttachmentsService
  /** §14.4 工作区写租约；测试替身与只读装配可以不传。 */
  readonly writeLease?: SubmissionWriteLeasePort
  readonly clock: Clock
  readonly logger: Logger
  /**
   * 库是只读打开的（ADR-004：库比程序新 / 迁移失败）：启动时不做提交恢复 —— 那一步要改库。
   * 不传等于可写。
   */
  readonly readOnly?: boolean
  /** 线程删除的持久副作用：与删行同一事务写 outbox。 */
  readonly enqueueThreadRemoved?: (threadId: string) => void
  readonly emitThreadUpdated: (thread: Thread) => void
  readonly emitThreadRemoved: (threadId: string) => void
  readonly emitTurnState: (state: TurnState) => void
  readonly emitTurnDropped: (p: { threadId: string; clientTurnId: string | null; text: string }) => void
  readonly emitQueue: (p: { threadId: string; queue: QueueView }) => void
  readonly emitControls: (p: { threadId: string; controls: Controls }) => void
  /** 上下文用量单独报（见契约里 controls.contextChanged 的头注：它不搭控件那班车） */
  readonly emitContextUsage: (p: { threadId: string; usage: ContextUsage | null }) => void
  /** 斜杠命令的输出与命令表变化（commands.output / commands.changed） */
  readonly emitCommandOutput: (p: { threadId: string; text: string; tone: CommandOutputTone }) => void
  readonly emitCommandsChanged: (p: { threadId: string }) => void
  /** 工具写了一处文件（引擎写的那一刻报）：Core 事件，账单归 review */
  readonly emitFileChanged: (p: { threadId: string } & FileChange) => void
  /** 模型步骤结束：conversation 在该步骤后打增量检查点。 */
  readonly onStepCompleted?: (p: { threadId: string; stepId: string }) => void
  /** 侧边提问（右坞辅助对话）的三条通知：side.topic / side.delta / side.notice */
  readonly emitSideTopic: (p: { threadId: string; topic: SideTopic }) => void
  readonly emitSideDelta: (p: SideDelta) => void
  readonly emitSideNotice: (p: { threadId: string; message: string }) => void
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
  readonly emitUsageSampled: (p: { threadId: string; sample: UsageSample; at: number }) => void
  /** 轮次上下文登记处（index.ts 建一个、同时作为 TurnContextRegistryToken 提供出去）；测试可缺省 */
  readonly turnContext?: TurnContextRegistry
  /** 用户发出去一句话（准入）→ usage 的「消息数量」日账（ADR 0039） */
  readonly emitUserMessage: (p: { threadId: string; at: number }) => void
}

/**
 * conversation 的 Core 组合根：
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
  readonly threads: ThreadsService
  /** 回合、时间线、队列、控件、交互 */
  readonly turns: TurnService
  /** 提交行的账（存库、重试、丢弃、按页盖章） */
  readonly submissions: SubmissionService

  constructor(d: ConversationCoreDeps) {
    const repo = d.repo

    /*
     * 三份服务互相引用（router 要读线程形状、pool 的 describe 要用 thread-service、
     * thread-service 又要问 pool 的状态），所以互相之间全部走**惰性闭包**：
     * 回调只在运行时才解开 `this.*`，构造期一条都不解引用。
     */
    this.threads = d.threads
    this.threads.configure({
      runtime: { sessionFiles: d.runtime.sessionFiles },
      workspaces: d.workspaces,
      attachments: d.attachments,
      hub: d.hub,
      sessionState: (threadId) => this.pool.peek(threadId)?.state() ?? 'idle',
      peekSession: (threadId) => this.pool.peek(threadId),
      isOpening: (threadId) => this.pool.isOpening(threadId),
      releaseSession: (threadId) => this.pool.release(threadId),
      emitThreadUpdated: d.emitThreadUpdated,
      emitThreadRemoved: d.emitThreadRemoved,
      onThreadRemoved: (threadId) => {
        this.router.forget(threadId)
        this.submissions.forget(threadId)
      },
      ...(d.enqueueThreadRemoved === undefined ? {} : { onThreadDeleted: d.enqueueThreadRemoved }),
    })

    this.pool = d.createSessionPool({
      runtime: d.runtime,
      clock: d.clock,
      logger: d.logger,
      describe: (threadId) => this.threads.describe(threadId),
      onOpened: (threadId, session) => {
        this.threads.onOpened(threadId, session)
        /*
         * 会话打开了（性能方案 P4）：没开着时屏幕上画的是冷读那一份（控件表快照、不含扩展与 MCP 提示词的命令表），
         * 这里主动报一次真值 —— 控件表走 controls 事件同一条路（推送 + 写快照），命令表让 UI 重读。
         * 读不出控件表只记一条 warn：不能因为它把刚开好的会话丢掉（这个回调抛错，会话池会 dispose 它）。
         */
        try {
          this.router.onEvent(threadId, { type: 'controls', controls: session.controls() })
        } catch (error) {
          d.logger.warn('controls snapshot on open failed', { threadId, error: String(error) })
        }
        d.emitCommandsChanged({ threadId })
      },
      onEvent: (threadId, event) => {
        this.router.onEvent(threadId, event)
      },
      onReleased: (threadId) => {
        this.threads.onReleased(threadId)
      },
    })

    /*
     * 「Core 即时回显」：提交的存库、推送、后台交接都归它。与 router 互相需要
     * （router 要认领 clientTurnId、它要 pool 开会话），所以两边都走**惰性引用**：
     * 这里只把 this 上的实例交给 router，调用发生在运行时。
     */
    this.submissions = d.submissionsService
    this.submissions.configure({
      workspaces: d.workspaces,
      attachments: d.attachments,
      ...(d.checkpoints === undefined ? {} : { checkpoints: d.checkpoints }),
      ...(d.journal === undefined ? {} : { journal: d.journal }),
      ...(d.writeLease === undefined ? {} : { writeLease: d.writeLease }),
      requireThread: (threadId) => this.threads.requireRow(threadId),
      autoTitle: (threadId, text) => this.threads.autoTitle(threadId, text),
      markActivity: (threadId) => this.threads.markActivity(threadId),
      emitChanged: d.emitSubmissionChanged,
      emitRemoved: d.emitSubmissionRemoved,
      emitFailed: d.emitSubmissionFailed,
      acquireSession: (threadId) => this.pool.acquire(threadId),
      emitUserMessage: d.emitUserMessage,
      ...(d.turnContext === undefined ? {} : { collectContext: (threadId) => d.turnContext!.collect(threadId) }),
    })

    this.router = d.createEventRouter({
      repo,
      hub: d.hub,
      journal: d.journal,
      submissions: this.submissions,
      clock: d.clock,
      threads: {
        threadOf: (row) => this.threads.threadOf(row as ThreadRow),
        setPosture: (threadId, posture) => this.threads.setPosture(threadId, posture),
        setTitleFromSession: (threadId, title, source, sessionFile) =>
          this.threads.setTitleFromSession(threadId, title, source, sessionFile),
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
      emitCommandOutput: d.emitCommandOutput,
      emitCommandsChanged: d.emitCommandsChanged,
      emitFileChanged: d.emitFileChanged,
      ...(d.onStepCompleted === undefined ? {} : { onStepCompleted: d.onStepCompleted }),
      emitSideTopic: d.emitSideTopic,
      emitSideDelta: d.emitSideDelta,
      emitSideNotice: d.emitSideNotice,
    })

    this.turns = d.turnService
    this.turns.configure({
      runtime: {
        commandCatalog: d.runtime.commandCatalog,
        draftControls: d.runtime.draftControls,
        models: d.runtime.models,
        sessionFiles: d.runtime.sessionFiles,
      },
      journal: d.journal,
      repo,
      pool: this.pool,
      router: this.router,
      submissions: this.submissions,
      workspaces: d.workspaces,
      threads: {
        requireRow: (threadId) => this.threads.requireRow(threadId),
        threadOf: (row) => this.threads.threadOf(row as ThreadRow),
        setPosture: (threadId, posture) => this.threads.setPosture(threadId, posture),
      },
      emitThreadUpdated: d.emitThreadUpdated,
      emitUserMessage: d.emitUserMessage,
    })

    /*
     * Core 启动时的提交恢复：`pending` 与 `queued` 一律收成 `core_restarted` —— 前者是上一次
     * 进程没来得及交出去的，后者排在 omp 的内存队列里、跟着进程一起消失了（R-08-5）；
     * `started` 里太旧的清掉（真实轮次在会话文件里，这里清的只是账）。
     */
    if (d.readOnly !== true) this.submissions.recoverOnStart()
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
