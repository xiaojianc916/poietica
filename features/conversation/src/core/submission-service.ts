import type { EngineSession } from '@poietica/engine'
import type { AttachmentsService } from '@poietica/feature-attachments/core-api'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import { AppError, type Clock, type Logger, toAppError } from '@poietica/foundation'
import type { SubmissionView } from '../contract'
import { conversationErrors } from '../contract/errors'
import { type SubmissionRow, type SubmissionsRepository, submissionOf } from './submissions-repository'
import { OWNER_KEY } from './thread-service'

/**
 * 「Core 即时回显」的提交服务（方案第 4 节）。
 *
 * 三条规则：
 * 1. 界面只画 Core 给的数据 —— 气泡就是本服务存下的这条记录；
 * 2. `turns.submit` **不等 omp**：先存库、推送、回复，打开会话与交给 omp 放后台；
 * 3. 每条提交都有确定结局并存进库（pending → started / queued / failed）。
 */
export interface SubmissionServiceDeps {
  readonly repo: SubmissionsRepository
  readonly workspaces: WorkspacesService
  readonly attachments: AttachmentsService
  readonly clock: Clock
  readonly logger: Logger
  readonly requireThread: (threadId: string) => { readonly id: string; readonly workspaceId: string }
  readonly autoTitle: (threadId: string, text: string) => void
  readonly emitChanged: (submission: SubmissionView) => void
  readonly emitRemoved: (p: { threadId: string; clientTurnId: string }) => void
  /** 「这句话没送达」→ Core 事件（automations 靠它收掉永远运行中的记录，R-06） */
  readonly emitFailed: (p: {
    threadId: string
    clientTurnId: string
    deliverAs: 'turn' | 'steer' | 'followUp'
    error: { code: string; message: string }
  }) => void
  /** 会话池：冷启动可能要很久，但气泡早就在了。 */
  readonly acquireSession: (threadId: string) => Promise<EngineSession>
  /** 用户发出去一句话（准入）→ usage 的日账 */
  readonly emitUserMessage: (p: { threadId: string; at: number }) => void
}

/** 同一线程的交接串行：两条提交不会同时在跑 `pool.acquire`。 */
interface Lane {
  readonly tail: Promise<void>
}

export class SubmissionService {
  /** threadId → 还没交给 omp 的提交号（`turn` 方式）。事件路由用它盖 clientTurnId。 */
  private readonly pendingTurn = new Map<string, string>()
  /** 已经交给 omp 的提交号：`turns.cancel` 不把这些人算成「还没交出去」。 */
  private readonly handed = new Set<string>()
  private readonly lanes = new Map<string, Lane>()
  /**
   * 进程内的 `turnId → clientTurnId` 缓存（R-08-2）。
   *
   * 流式期间每条 `turn.upsert` 都要问一次号（事件路由每条 upsert 补号）：先前每次都同步
   * 查一次库。命中就直接答；没命中查一次库，把结果（**包括 null**）写回 —— null 也要缓存，
   * 否则认不出号的 turn 会每条 upsert 都再查一次。
   *
   * `markTurn` 必须覆盖 null（先查后认领是真实顺序），线程删除时随 `forget` 一起清掉。
   */
  private readonly turnIds = new Map<string, Map<string, string | null>>()

  constructor(private readonly d: SubmissionServiceDeps) {}

  // ── 提交 ─────────────────────────────────────────────────────────────────
  submit(input: {
    threadId: string
    clientTurnId: string
    text: string
    attachmentIds: readonly string[]
    skills: readonly string[]
    deliverAs: 'turn' | 'steer' | 'followUp'
  }): SubmissionView {
    /* 幂等：同一个 clientTurnId 再来，直接交回已有记录。 */
    const existing = this.d.repo.get(input.clientTurnId)
    if (existing !== null) return submissionOf(existing)

    /* 快速检查：只查表，不碰 omp、不读文件。 */
    const thread = this.d.requireThread(input.threadId)
    this.d.workspaces.requireUsable(thread.workspaceId)
    const attachments = this.d.attachments.describe(input.attachmentIds)

    const at = this.d.clock.now()
    const row: SubmissionRow = {
      clientTurnId: input.clientTurnId,
      threadId: input.threadId,
      text: input.text,
      attachments: [...attachments],
      skills: [...input.skills],
      requestedAs: input.deliverAs,
      status: 'pending',
      turnId: null,
      error: null,
      rev: 1,
      createdAt: at,
      updatedAt: at,
    }
    this.d.repo.insert(row)
    /*
     * R-07 §3.3：引用在「被接受」（写库）时就登记，不等 `deliver`。
     *
     * 旧位置在交接时（`resolve` 之后）：写库到交接之间、以及交接失败的 failed 行，
     * 它们的附件都没有引用，24 小时回收会连文件一起删掉，隔天重试永远报 not_found。
     * 这一句与 insert 同一同步段，中间不会被回收插进来。
     */
    this.d.attachments.retain(input.attachmentIds, OWNER_KEY(input.threadId))
    const view = submissionOf(row)
    this.d.emitChanged(view)

    if (input.deliverAs === 'turn') this.d.autoTitle(input.threadId, input.text)

    this.enqueue(input.threadId, () => this.handOver(input.clientTurnId))
    return view
  }

  retry(clientTurnId: string): SubmissionView {
    const row = this.d.repo.get(clientTurnId)
    if (row === null) throw new AppError(conversationErrors.thread_not_found, '这条提交不存在')
    if (row.status !== 'failed') throw new AppError(conversationErrors.thread_busy, '只有失败的提交可以重试')
    const next = this.d.repo.update(clientTurnId, { status: 'pending', error: null, turnId: null })
    if (next === null) throw new AppError(conversationErrors.thread_not_found, '这条提交不存在')
    const view = submissionOf(next)
    this.d.emitChanged(view)
    this.enqueue(next.threadId, () => this.handOver(clientTurnId))
    return view
  }

  discard(clientTurnId: string): { threadId: string; clientTurnId: string } {
    const row = this.d.repo.get(clientTurnId)
    if (row === null) throw new AppError(conversationErrors.thread_not_found, '这条提交不存在')
    if (row.status !== 'failed') throw new AppError(conversationErrors.thread_busy, '只有失败的提交可以删除')
    this.d.repo.delete(clientTurnId)
    return { threadId: row.threadId, clientTurnId }
  }

  // ── 读 ───────────────────────────────────────────────────────────────────
  /** 时间线订阅要的那些行：pending / failed，加上 turnId 不在本页里的 started。 */
  viewOfThread(threadId: string, stamped: ReadonlySet<string>): SubmissionView[] {
    return this.d.repo
      .listByThread(threadId)
      .filter(
        (row) =>
          row.status === 'pending' || row.status === 'failed' || !(row.turnId !== null && stamped.has(row.turnId)),
      )
      .map(submissionOf)
  }

  /**
   * 给一页快照里的 turn 补上 `clientTurnId`（方案第 4 节的「快照」一行）。
   *
   * 实时那条路（事件路由）已经在推送前盖好；快照走的是引擎的 `page()`，它不认识
   * 我们的提交号，所以在返回前按 `turnId → clientTurnId` 补一次。两头都盖，
   * 界面才拿得到「同一个号」去把提交行换成真实 turn。
   */
  stampPage<T extends { readonly items: readonly unknown[] }>(threadId: string, page: T): T {
    const map = this.d.repo.mapByTurnId(threadId)
    if (map.size === 0) return page
    let touched = false
    const items = page.items.map((item) => {
      const entry = item as { readonly kind?: unknown; readonly turnId?: unknown }
      if (entry.kind !== 'turn' || typeof entry.turnId !== 'string') return item
      const clientTurnId = map.get(entry.turnId)
      if (clientTurnId === undefined) return item
      touched = true
      return { ...(item as object), clientTurnId }
    })
    return touched ? ({ ...page, items } as T) : page
  }

  // ── 事件路由用的两口 ──────────────────────────────────────────────────────
  /**
   * 这一条线程里某个 turnId 对应的提交号（事件路由每条 upsert 补号用；没有就是 null）。
   */
  clientTurnIdOf(threadId: string, turnId: string): string | null {
    const cache = this.turnIds.get(threadId) ?? new Map<string, string | null>()
    if (cache.has(turnId)) return cache.get(turnId) ?? null
    const row = this.d.repo.findByTurnId(threadId, turnId)
    const clientTurnId = row === null ? null : row.clientTurnId
    /* 把「查过、没有」也记住：认不出号的 turn 不再每条 upsert 都去问库一次 */
    cache.set(turnId, clientTurnId)
    this.turnIds.set(threadId, cache)
    return clientTurnId
  }

  /** 这一轮的 `clientTurnId`（待交的那条）；没有就是 null。事件路由只问一次。 */
  claimPendingTurn(threadId: string): string | null {
    const id = this.pendingTurn.get(threadId)
    if (id === undefined) return null
    this.pendingTurn.delete(threadId)
    const row = this.d.repo.get(id)
    if (row !== null && row.status === 'pending') {
      const next = this.d.repo.update(id, { status: 'started' })
      if (next !== null) this.d.emitChanged(submissionOf(next))
    }
    return id
  }

  /** 记下这一轮的真实 turnId（事件路由拿到 turn.upsert 时）。 */
  markTurn(threadId: string, clientTurnId: string, turnId: string): void {
    /* 覆盖缓存里的 null：先查后认领是真实顺序（R-08-2），这里必须把号补上 */
    const cache = this.turnIds.get(threadId) ?? new Map<string, string | null>()
    cache.set(turnId, clientTurnId)
    this.turnIds.set(threadId, cache)
    const row = this.d.repo.get(clientTurnId)
    if (row === null) return
    const next = this.d.repo.update(clientTurnId, { status: 'started', turnId })
    if (next !== null) this.d.emitChanged(submissionOf(next))
  }

  /** `turns.state` 回到 idle 而这一轮没开出来：收成 failed。 */
  settleUnstarted(threadId: string, error: { code: string; message: string }): void {
    const id = this.pendingTurn.get(threadId)
    if (id === undefined) return
    this.pendingTurn.delete(threadId)
    const row = this.d.repo.get(id)
    if (row === null || row.status !== 'pending') return
    this.markFailed(row, error)
  }

  /** 取消：还没交给 omp 的 pending 直接收成 failed（交给 omp 的照旧走 session.cancel）。 */
  cancelUnhanded(threadId: string): void {
    const id = this.pendingTurn.get(threadId)
    if (id === undefined || this.handed.has(id)) return
    this.pendingTurn.delete(threadId)
    const row = this.d.repo.get(id)
    if (row === null || row.status !== 'pending') return
    this.markFailed(row, {
      code: conversationErrors.submit_cancelled,
      message: conversationErrors.submit_cancelled,
    })
  }

  /** Core 启动：pending → failed / core_restarted；太旧的 started / queued 删除。 */
  recoverOnStart(): void {
    const at = this.d.clock.now()
    const error = {
      code: conversationErrors.core_restarted,
      message: conversationErrors.core_restarted,
    }
    for (const row of this.d.repo.failPending(error)) {
      this.d.emitChanged(submissionOf(row))
      /*
       * 仓储已经改过库，这里只补事件：automations 的订阅那时还没建立（拓扑序 conversation 在前），
       * 它自己的 repairOnStartup 会把全部 open run 收成 failed —— 两处各管各的那一半。
       */
      this.d.emitFailed({
        threadId: row.threadId,
        clientTurnId: row.clientTurnId,
        deliverAs: row.requestedAs,
        error,
      })
    }
    this.d.repo.deleteStaleTerminal(at - 7 * 24 * 60 * 60 * 1000)
  }

  /**
   * 线程已删：丢掉这条线程的交接车道与待认领号（库里的行已经随线程级联删除）。
   * 这是 R-03 的统一遗忘钩子的提交服务这一半 —— 少了它，Core 这个长期运行的进程
   * 会随自动化不断建线程而永久积累 lanes / pendingTurn / handed。
   */
  forget(threadId: string): void {
    this.lanes.delete(threadId)
    const pending = this.pendingTurn.get(threadId)
    if (pending !== undefined) this.handed.delete(pending)
    this.pendingTurn.delete(threadId)
    /* R-08-2：按线程索引的号表跟线程一起走（只增不减就是内存泄漏） */
    this.turnIds.delete(threadId)
  }

  /** 测试用：这条线程是否还有按线程索引的状态（交接车道 / 待认领号） */
  has(threadId: string): boolean {
    return this.lanes.has(threadId) || this.pendingTurn.has(threadId) || this.turnIds.has(threadId)
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────
  private enqueue(threadId: string, work: () => Promise<void>): void {
    const previous = this.lanes.get(threadId)?.tail ?? Promise.resolve()
    const tail = previous.then(work).catch((cause: unknown) => {
      this.d.logger.warn('submission hand-over failed', { threadId, error: String(cause) })
    })
    this.lanes.set(threadId, { tail })
    // 车道的尾巴自己收口：不收的话每跑一条线程就永久留一项（R-03 §2.3 顺带修）
    void tail.finally(() => {
      if (this.lanes.get(threadId)?.tail === tail) this.lanes.delete(threadId)
    })
  }

  private async handOver(clientTurnId: string): Promise<void> {
    const row = this.d.repo.get(clientTurnId)
    if (row === null || row.status !== 'pending') return
    try {
      await this.deliver(row)
    } catch (cause) {
      this.fail(clientTurnId, row.threadId, cause)
    } finally {
      this.handed.delete(clientTurnId)
    }
  }

  /** 交给 omp 的那一段（拆出来只为让复杂度落在闸门内；顺序与方案逐条对应）。 */
  private async deliver(row: SubmissionRow): Promise<void> {
    const ids = row.attachments.map((a) => a.id)
    const resolved = this.d.attachments.resolve(ids)

    /* 冷启动可能要很久，但气泡早就在了（方案第 6 节）。 */
    const session = await this.d.acquireSession(row.threadId)
    /* 等待期间被停止 / 丢弃：不要交出去。 */
    const current = this.d.repo.get(row.clientTurnId)
    if (current === null || current.status !== 'pending') return

    const deliveredAs = row.requestedAs === 'turn' && session.state() !== 'idle' ? 'followUp' : row.requestedAs
    this.handed.add(row.clientTurnId)
    if (deliveredAs === 'turn') this.pendingTurn.set(row.threadId, row.clientTurnId)

    await session.submit({
      text: row.text,
      images: resolved.filter((a) => a.kind === 'image').map((a) => ({ path: a.path, mime: a.mime })),
      files: resolved.filter((a) => a.kind === 'file').map((a) => ({ path: a.path, name: a.name })),
      skills: [...row.skills],
      deliverAs: deliveredAs,
    })
    if (deliveredAs !== 'turn') {
      this.update(row.clientTurnId, { status: 'queued' })
    } else if (this.pendingTurn.get(row.threadId) === row.clientTurnId && session.state() === 'idle') {
      throw new AppError(conversationErrors.submit_dropped, conversationErrors.submit_dropped)
    }
    this.d.emitUserMessage({ threadId: row.threadId, at: this.d.clock.now() })
  }

  /** 失败结局（方案第 2 节的状态表：没送达 → failed，错误码原样存下）。 */
  private fail(clientTurnId: string, threadId: string, cause: unknown): void {
    if (this.pendingTurn.get(threadId) === clientTurnId) this.pendingTurn.delete(threadId)
    const row = this.d.repo.get(clientTurnId)
    if (row === null) return
    const mapped = toAppError(cause)
    this.markFailed(row, { code: mapped.code, message: mapped.message })
  }

  /** 唯一的「变为 failed」出口：写库、推 UI、发 Core 事件（R-06 §3.2） */
  private markFailed(row: SubmissionRow, error: { code: string; message: string }): void {
    const next = this.d.repo.update(row.clientTurnId, { status: 'failed', error })
    if (next === null) return
    this.d.emitChanged(submissionOf(next))
    this.d.emitFailed({
      threadId: next.threadId,
      clientTurnId: next.clientTurnId,
      deliverAs: next.requestedAs,
      error,
    })
  }

  /** 改一行并推送（rev 由 repo 自增）。 */
  private update(
    clientTurnId: string,
    patch: { status: SubmissionView['status']; error?: SubmissionView['error'] },
  ): void {
    const next = this.d.repo.update(clientTurnId, {
      status: patch.status,
      ...(patch.error === undefined ? {} : { error: patch.error }),
    })
    if (next !== null) this.d.emitChanged(submissionOf(next))
  }
}
