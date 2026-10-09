import type {
  AgentEngine,
  Controls,
  EngineSession,
  Interaction,
  InteractionAnswer,
  ModelRef,
  Posture,
  QueueSnapshot,
} from '@poietica/engine'
import type { AttachmentsService } from '@poietica/feature-attachments/core-api'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import { AppError, type Clock, type Logger, SystemErrorCode } from '@poietica/foundation'
import type { TranscriptPage } from '@poietica/transcript'
import { DEFAULT_POSTURE, type Thread, type TurnState } from '../contract/entities'
import { conversationErrors } from '../contract/errors'
import type { EventRouter } from './event-router'
import type { ThreadsRepository } from './repository'
import type { SessionPool } from './session-pool'
import type { TimelineHub } from './timeline-hub'

/**
 * 回合服务（07 页 §5C 的 `turn-service.ts`）：submit / cancel / queue / controls / interactions，
 * 以及时间线的三段读（page / subscribe / catchUp 的数据面）。
 */
export interface TurnServiceDeps {
  readonly engine: AgentEngine
  readonly repo: ThreadsRepository
  readonly pool: SessionPool
  readonly hub: TimelineHub
  readonly router: EventRouter
  /** 「Core 即时回显」的提交服务：submit / cancel / retry / discard 都归它。 */
  readonly submissions: import('./submission-service').SubmissionService
  readonly workspaces: WorkspacesService
  readonly attachments: AttachmentsService
  readonly clock: Clock
  readonly logger: Logger
  readonly requireRow: (threadId: string) => import('./repository').ThreadRow
  /** 线程服务：setPostureAction 要同时把线程行改掉；读线程形状走 threadOf */
  readonly threads: {
    threadOf(row: import('./repository').ThreadRow): Thread
    setPosture(threadId: string, posture: Posture): void
  }
  readonly emitThreadUpdated: (thread: Thread) => void
  /** 用户发出去一句话（准入）→ usage 的日账（07 页 §5C / ADR 0039） */
  readonly emitUserMessage: (p: { threadId: string; at: number }) => void
}

export class TurnService {
  constructor(private readonly d: TurnServiceDeps) {}

  // ── 会话池的四个口（供 handlers / 组合根用）───────────────────────────────
  peek(threadId: string): EngineSession | undefined {
    return this.d.pool.peek(threadId)
  }

  async acquire(threadId: string): Promise<EngineSession> {
    return this.d.pool.acquire(threadId)
  }

  async open(threadId: string): Promise<void> {
    this.d.requireRow(threadId)
    await this.d.pool.acquire(threadId).catch((e: unknown) => {
      this.d.logger.warn('session prewarm failed', { threadId, error: String(e) })
      return undefined
    })
  }

  async close(threadId: string): Promise<void> {
    const session = this.d.pool.peek(threadId)
    if (session === undefined || session.isBusy()) return
    await this.d.pool.release(threadId)
  }

  async releaseIdle(): Promise<void> {
    await this.d.pool.releaseIdle()
  }

  // ── 回合（07 页 §5C 服务行为表）──────────────────────────────────────────
  async submit(input: {
    threadId: string
    clientTurnId: string
    text: string
    attachmentIds: readonly string[]
    skills: readonly string[]
    deliverAs: 'turn' | 'steer' | 'followUp'
  }): Promise<{ submission: import('../contract').SubmissionView }> {
    /*
     * 「Core 即时回显」：这里只存库、推送、回复（几毫秒），打开会话与交给 omp 由
     * SubmissionService 在后台做。忙时不再报 thread_busy —— 交接时自动改成排队。
     */
    return { submission: this.d.submissions.submit(input) }
  }

  async cancel(threadId: string): Promise<void> {
    /* 还没交给 omp 的 pending 直接收成 failed / submit_cancelled（方案第 4 节）。 */
    this.d.submissions.cancelUnhanded(threadId)
    const session = this.d.pool.peek(threadId)
    if (session === undefined) return
    this.d.router.requestCancel(threadId)
    await session.cancel()
  }

  /** 时间线订阅要画的提交行（方案：线程还没有会话时也要返回）。 */
  submissionsOf(threadId: string, stamped: ReadonlySet<string>): import('../contract').SubmissionView[] {
    return this.d.submissions.viewOfThread(threadId, stamped)
  }

  // ── 时间线（07 页 §5C 的 timeline 三段）───────────────────────────────────
  /** 空页：线程还没有会话时 timeline.subscribe 用它（不打开会话） */
  emptyPage(): TranscriptPage {
    return {
      items: [],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
      hasMoreOlder: false,
    } as TranscriptPage
  }

  async page(threadId: string, agentId: string, beforeTurnId: string | null): Promise<TranscriptPage> {
    const session = await this.d.pool.acquire(threadId)
    return session.page(agentId, beforeTurnId)
  }

  // ── 队列（07 页 §5C 的 queue 三方法）──────────────────────────────────────
  async queue(threadId: string): Promise<QueueSnapshot> {
    const session = await this.d.pool.acquire(threadId)
    return session.queue()
  }

  async withdraw(threadId: string, itemId: string): Promise<QueueSnapshot> {
    /*
     * 队列只存在于活会话里（peek 不 acquire）：为撤回一条排队项去冷启动一条会话没有意义，
     * 冷启动出来的队列一定是空的。没有活会话就是「队列里没有这一项」。
     */
    const session = this.d.pool.peek(threadId)
    if (session === undefined) throw new AppError(SystemErrorCode.notFound, '队列里没有这一项')
    session.withdraw(itemId)
    return session.queue()
  }

  /**
   * 换层（steer ⇄ followUp）：同样只对活会话操作，用账本里的原始输入重新入队，
   * 附件与技能一样不丢（R-01 §3.8）。已被 agent 消费的项由引擎抛
   * `engine.queue_item_consumed`，这里原样放行。
   */
  async move(threadId: string, itemId: string, deliverAs: 'steer' | 'followUp'): Promise<QueueSnapshot> {
    const session = this.d.pool.peek(threadId)
    if (session === undefined) throw new AppError(SystemErrorCode.notFound, '队列里没有这一项')
    await session.moveQueued(itemId, deliverAs)
    return session.queue()
  }

  async setQueueModes(threadId: string, modes: Partial<QueueSnapshot['modes']>): Promise<QueueSnapshot> {
    const session = await this.d.pool.acquire(threadId)
    session.setQueueModes(modes)
    return session.queue()
  }

  // ── 控件（07 页 §5C 的 controls 六方法 + 草稿）─────────────────────────────
  async controls(threadId: string): Promise<Controls> {
    const session = await this.d.pool.acquire(threadId)
    return session.controls()
  }

  /**
   * 入口那一格（还没有对话）的**草稿**控件表（方案 §04/§05）。
   *
   * `controls.get` 的免会话版本：**不开会话、不写设置、不碰文件**，只是把引擎那一支
   * `draftControls` 转发出去。`init` 只决定哪一格被选中（用户改过的草稿），不改全局默认。
   */
  async draftControls(init: {
    model: ModelRef | null
    thinking: string | null
    posture: Posture | null
  }): Promise<Controls> {
    return this.d.engine.draftControls({
      model: init.model,
      thinking: init.thinking,
      posture: init.posture ?? DEFAULT_POSTURE,
    })
  }

  async setModel(threadId: string, model: ModelRef): Promise<Controls> {
    const session = await this.d.pool.acquire(threadId)
    await session.setModel(model)
    return session.controls()
  }

  async setThinking(threadId: string, level: string): Promise<Controls> {
    const session = await this.d.pool.acquire(threadId)
    session.setThinking(level)
    return session.controls()
  }

  /** controls.setPosture 同时更新线程行，保证两边一致 */
  async setPostureAction(threadId: string, posture: Posture): Promise<Controls> {
    const session = await this.d.pool.acquire(threadId)
    session.setPosture(posture)
    this.d.threads.setPosture(threadId, posture)
    return session.controls()
  }

  async setPlanMode(threadId: string, enabled: boolean): Promise<Controls> {
    const session = await this.d.pool.acquire(threadId)
    await session.setPlanMode(enabled)
    return session.controls()
  }

  async setGoal(threadId: string, goal: string | null): Promise<Controls> {
    const session = await this.d.pool.acquire(threadId)
    await session.setGoal(goal)
    return session.controls()
  }

  // ── 交互（07 页 §5C 的 interactions 两方法）───────────────────────────────
  interactions(threadId: string): readonly Interaction[] {
    return this.d.pool.peek(threadId)?.interactions() ?? []
  }

  async respond(threadId: string, interactionId: string, answer: InteractionAnswer): Promise<void> {
    const session = this.d.pool.peek(threadId)
    if (session === undefined) {
      throw new AppError(conversationErrors.interaction_not_found, '这个请求已经失效')
    }
    session.respond(interactionId, answer)
  }

  // ── 小工具 ────────────────────────────────────────────────────────────────
  /** 线程此刻的运行时状态（会话不在池中时为 idle） */
  stateOf(threadId: string): TurnState['state'] {
    return this.d.pool.peek(threadId)?.state() ?? 'idle'
  }
}
