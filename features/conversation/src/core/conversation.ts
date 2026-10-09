import type {
  AgentEngine,
  ContextUsage,
  Controls,
  EngineSession,
  EngineSessionEvent,
  Interaction,
  InteractionAnswer,
  ModelRef,
  Posture,
  QueueSnapshot,
  UsageSample,
} from '@poietica/engine'
import type { AttachmentsService } from '@poietica/feature-attachments/core-api'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import type { Clock, Logger } from '@poietica/foundation'
import type { TranscriptPage } from '@poietica/transcript'
import type { SubmissionView, Thread, TurnState } from '../contract/entities'
import { EventRouter } from './event-router'
import { createThreadsRepository, type ThreadRow } from './repository'
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
 * 这一层只做**接线与转发**，不写业务：它把三份服务互相要用的口接起来，再把契约方法
 * 原样交给它们（handlers.ts 只跟这一个对象说话，07 页 §5C 的「装配」）。
 */
export class ConversationCore {
  private readonly pool: SessionPool
  private readonly router: EventRouter
  private readonly threads: ThreadService
  private readonly turns: TurnService
  private readonly submissions: SubmissionService

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
      releaseSession: (threadId) => this.pool.release(threadId),
      onSessionReleased: (threadId) => {
        this.threads.onReleased(threadId)
      },
      emitThreadUpdated: d.emitThreadUpdated,
      emitThreadRemoved: d.emitThreadRemoved,
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
     * Core 启动时的提交恢复（方案第 4 节）：`pending` 一律收成 `core_restarted`
     * （上一次进程没来得及交出去），`started` / `queued` 里太旧的清掉。
     */
    this.submissions.recoverOnStart()
  }

  // ── 转发：读（thread-service）──────────────────────────────────────────────
  row(id: string): ThreadRow | null {
    return this.threads.row(id)
  }
  requireRow(id: string): ThreadRow {
    return this.threads.requireRow(id)
  }
  threadOf(row: ThreadRow): Thread {
    return this.threads.threadOf(row)
  }
  stateOf(threadId: string): TurnState['state'] {
    return this.threads.stateOf(threadId)
  }
  list(q: { workspaceId?: string | undefined; includeArchived: boolean }): Thread[] {
    return this.threads.list(q)
  }

  // ── 转发：线程 CRUD ────────────────────────────────────────────────────────
  create(init: Parameters<ThreadService['create']>[0]): ThreadRow {
    return this.threads.create(init)
  }
  rename(id: string, title: string): ThreadRow {
    return this.threads.rename(id, title)
  }
  setPinned(id: string, pinned: boolean): ThreadRow {
    return this.threads.setPinned(id, pinned)
  }
  setArchived(id: string, archived: boolean): ThreadRow {
    return this.threads.setArchived(id, archived)
  }
  setPosture(id: string, posture: Posture): void {
    this.threads.setPosture(id, posture)
  }
  async delete(threadId: string): Promise<void> {
    await this.threads.delete(threadId)
  }
  async fork(threadId: string, undoTurns: number, title?: string): Promise<ThreadRow> {
    return this.threads.fork(threadId, undoTurns, title)
  }
  async exportThread(threadId: string, format: 'html' | 'markdown', targetPath: string): Promise<{ path: string }> {
    return this.threads.exportThread(threadId, format, targetPath)
  }
  async removeWorkspaceThreads(workspaceId: string): Promise<void> {
    await this.threads.removeWorkspaceThreads(workspaceId)
  }

  // ── 转发：会话池 ───────────────────────────────────────────────────────────
  peek(threadId: string): EngineSession | undefined {
    return this.turns.peek(threadId)
  }
  async acquire(threadId: string): Promise<EngineSession> {
    return this.turns.acquire(threadId)
  }
  async open(threadId: string): Promise<void> {
    await this.turns.open(threadId)
  }
  async close(threadId: string): Promise<void> {
    await this.turns.close(threadId)
  }
  async releaseIdle(): Promise<void> {
    await this.turns.releaseIdle()
  }
  async dispose(): Promise<void> {
    await this.pool.dispose()
  }

  // ── 转发：回合与时间线 ─────────────────────────────────────────────────────
  async submit(input: Parameters<TurnService['submit']>[0]): Promise<{ submission: SubmissionView }> {
    return this.turns.submit(input)
  }
  retrySubmission(clientTurnId: string): SubmissionView {
    return this.submissions.retry(clientTurnId)
  }
  discardSubmission(clientTurnId: string): void {
    this.submissions.discard(clientTurnId)
  }
  submissionsOf(threadId: string, stamped: ReadonlySet<string>): SubmissionView[] {
    return this.turns.submissionsOf(threadId, stamped)
  }
  stampSubmissions<T extends { readonly items: readonly unknown[] }>(threadId: string, page: T): T {
    return this.submissions.stampPage(threadId, page)
  }
  async cancel(threadId: string): Promise<void> {
    await this.turns.cancel(threadId)
  }
  emptyPage(): TranscriptPage {
    return this.turns.emptyPage()
  }
  async page(threadId: string, agentId: string, beforeTurnId: string | null): Promise<TranscriptPage> {
    return this.turns.page(threadId, agentId, beforeTurnId)
  }

  // ── 转发：队列 / 控件 / 交互 ───────────────────────────────────────────────
  async queue(threadId: string): Promise<QueueSnapshot> {
    return this.turns.queue(threadId)
  }
  async withdraw(threadId: string, itemId: string): Promise<QueueSnapshot> {
    return this.turns.withdraw(threadId, itemId)
  }
  async setQueueModes(threadId: string, modes: Partial<QueueSnapshot['modes']>): Promise<QueueSnapshot> {
    return this.turns.setQueueModes(threadId, modes)
  }
  async controls(threadId: string): Promise<Controls> {
    return this.turns.controls(threadId)
  }
  async draftControls(init: Parameters<TurnService['draftControls']>[0]): Promise<Controls> {
    return this.turns.draftControls(init)
  }
  async setModel(threadId: string, model: ModelRef): Promise<Controls> {
    return this.turns.setModel(threadId, model)
  }
  async setThinking(threadId: string, level: string): Promise<Controls> {
    return this.turns.setThinking(threadId, level)
  }
  async setPostureAction(threadId: string, posture: Posture): Promise<Controls> {
    return this.turns.setPostureAction(threadId, posture)
  }
  async setPlanMode(threadId: string, enabled: boolean): Promise<Controls> {
    return this.turns.setPlanMode(threadId, enabled)
  }
  async setGoal(threadId: string, goal: string | null): Promise<Controls> {
    return this.turns.setGoal(threadId, goal)
  }
  interactions(threadId: string): readonly Interaction[] {
    return this.turns.interactions(threadId)
  }
  async respond(threadId: string, interactionId: string, answer: InteractionAnswer): Promise<void> {
    await this.turns.respond(threadId, interactionId, answer)
  }

  /** 事件路由（会话池之外手动投递时用；单测可直接喂事件） */
  onEvent(threadId: string, event: EngineSessionEvent): void {
    this.router.onEvent(threadId, event)
  }
}
