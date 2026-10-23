import type { EngineSession, QueueOutcome, QueueSnapshot } from '@poietica/engine'
import type { AttachmentsService } from '@poietica/feature-attachments/core-api'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import { AppError, type Clock, type Logger, toAppError } from '@poietica/foundation'
import type { TranscriptPage } from '@poietica/transcript'
import type { QueueView, SubmissionView } from '../contract'
import { conversationErrors } from '../contract/errors'
import { type SubmissionRow, type SubmissionsRepository, submissionOf } from './submissions-repository'
import { OWNER_KEY } from './thread-service'
import type { CollectedContext } from './turn-context'

/**
 * 「Core 即时回显」的提交服务。三条规则：
 * 1. 界面只画 Core 给的数据 —— 气泡就是本服务存下的这条记录；
 * 2. `turns.submit` **不等 omp**：先存库、推送、回复，打开会话与交给 omp 放后台；
 * 3. 每条提交都有确定结局并存进库（pending → started / queued / failed）。`queued` 不是结局：引擎报回
 *    `queueSettled` 时收口 —— 送达 / 撤回删行，被丢弃改 failed（审查 R-20-1）。
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
  /** 轮次上下文（别的功能经 TurnContextRegistry 交来）：交接那一刻同步收一次。缺省 = 没有提供方 */
  readonly collectContext?: (threadId: string) => CollectedContext
}

/** 同一线程的交接串行：两条提交不会同时在跑 `pool.acquire`。 */
interface Lane {
  readonly tail: Promise<void>
}

/**
 * 排队项（steer / followUp）随附的轮次上下文：引擎收下就记已交（下一句不会再带一遍），结局是丢弃 / 撤回
 * 再撤销。结局可能先于 `submit` 返回到达（omp 在 submit 里就消化了队列）：先记在 `settled`，submit 回来再按它办。
 */
interface QueuedContext {
  readonly threadId: string
  readonly context: CollectedContext
  readonly submitted: boolean
  readonly settled: QueueOutcome | null
}

export class SubmissionService {
  /** threadId → 还没交给 omp 的提交号（`turn` 方式）。事件路由用它盖 clientTurnId。 */
  private readonly pendingTurn = new Map<string, string>()
  /** 已经交给 omp 的提交号：`turns.cancel` 不把这些人算成「还没交出去」。 */
  private readonly handed = new Set<string>()
  private readonly lanes = new Map<string, Lane>()
  /**
   * 进程内的 `turnId → clientTurnId` 缓存（R-08-2）：流式期间每条 `turn.upsert` 都要问一次号，
   * 不缓存就是每条都同步查一次库。
   *
   * **null 也要缓存** —— 否则认不出号的 turn 每条 upsert 都再查一次。`markTurn` 必须能覆盖
   * null（先查后认领是真实顺序）；线程删除时随 `forget` 一起清掉。
   */
  private readonly turnIds = new Map<string, Map<string, string | null>>()
  /** clientTurnId → 排队项随附的上下文，等 `queueSettled` 收口；线程删除时随 `forget` 清掉 */
  private readonly queuedContexts = new Map<string, QueuedContext>()

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
    this.supersedeFailed(input.threadId, input.clientTurnId)
    /*
     * R-07 §3.3：引用在「被接受」（写库）时就登记，不等 `deliver`。
     *
     * 写库到交接之间、以及交接失败的 failed 行，若不在此登记就都没有引用，24 小时回收会连
     * 文件一起删掉，隔天重试永远报 not_found。这一句与 insert 同一同步段，中间不会被回收插进来。
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
    this.dropQueuedContext(clientTurnId, true)
    this.d.repo.delete(clientTurnId)
    /* 别的窗口 / 重开的对话里也画着这一行：只回 RPC 不推事件，那边的气泡与横幅就一直挂着 */
    this.d.emitRemoved({ threadId: row.threadId, clientTurnId })
    return { threadId: row.threadId, clientTurnId }
  }

  /**
   * 排队项（steer / followUp，含忙时降级成 followUp 的 turn）的结局（审查 R-20-1）。
   *
   * - `delivered` / `withdrawn`：删行并推 `submissions.removed` —— 送达后那句话是会话文件里的事实，
   *   撤回后它不该再出现；留着就是下次 Core 启动被 `recoverOnStart` 当成「没送到」改成 failed。
   * - `dropped`：omp 丢了它，收成 failed（用户可以重试 / 取回文字）。
   *
   * 幂等：行已不在、已有别的结局、或根本不是这条线程的，一律不动。`pending` 只在已交给引擎时认 ——
   * 结局可能先于 `deliver` 里那句 `queued` 落库到达。
   */
  settleQueued(threadId: string, clientTurnId: string, outcome: QueueOutcome): void {
    this.settleQueuedContext(threadId, clientTurnId, outcome)
    const row = this.d.repo.get(clientTurnId)
    if (row === null || row.threadId !== threadId) return
    const waiting = row.status === 'queued' || (row.status === 'pending' && this.handed.has(clientTurnId))
    if (!waiting) return
    if (outcome === 'dropped') {
      this.markFailed(row, { code: conversationErrors.submit_dropped, message: conversationErrors.submit_dropped })
      return
    }
    this.d.repo.delete(clientTurnId)
    this.d.emitRemoved({ threadId, clientTurnId })
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
   * 给一页快照里的 turn 补上 `clientTurnId`。
   *
   * 实时那条路（事件路由）已经在推送前盖好；快照走的是引擎的 `page()`，它不认识我们的提交号，
   * 所以在返回前按 `turnId → clientTurnId` 补一次。两头都盖，界面才拿得到「同一个号」去把
   * 提交行换成真实 turn。
   */
  stampPage(threadId: string, page: TranscriptPage): TranscriptPage {
    const map = this.d.repo.mapByTurnId(threadId)
    if (map.size === 0) return page
    let touched = false
    const items = page.items.map((item) => {
      if (item.kind !== 'turn') return item
      const clientTurnId = map.get(item.turnId)
      if (clientTurnId === undefined) return item
      touched = true
      return { ...item, clientTurnId }
    })
    return touched ? { ...page, items } : page
  }

  /**
   * 引擎的队列快照 → 界面版：每一项按 `ref`（就是本服务交给引擎的 clientTurnId）找回自己那条提交行，挂上它的附件。
   * 排队期间提交行一直在（`pending` / `queued`；送达与撤回才删行），换层用的是同一个号，所以换层后图也不丢。
   * 号对不上、或不是这条线程的行，一律当作没有附件 —— 这一格只用来画，不用来判。
   */
  queueViewOf(threadId: string, snapshot: QueueSnapshot): QueueView {
    return {
      modes: { ...snapshot.modes },
      items: snapshot.items.map((item) => {
        const row = item.ref === undefined ? null : this.d.repo.get(item.ref)
        return {
          id: item.id,
          text: item.text,
          deliverAs: item.deliverAs,
          createdAt: item.createdAt,
          attachments: row === null || row.threadId !== threadId ? [] : [...row.attachments],
        }
      }),
    }
  }

  // ── 事件路由用的两口 ──────────────────────────────────────────────────────
  /** 这一条线程里某个 turnId 对应的提交号（事件路由每条 upsert 补号用；没有就是 null）。 */
  clientTurnIdOf(threadId: string, turnId: string): string | null {
    const cache = this.turnIds.get(threadId) ?? new Map<string, string | null>()
    if (cache.has(turnId)) return cache.get(turnId) ?? null
    const row = this.d.repo.findByTurnId(threadId, turnId)
    const clientTurnId = row === null ? null : row.clientTurnId
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
    /* 行不在了（已删）update 就是 null：不必先读一遍 */
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

  /**
   * Core 启动：`pending` / `queued` → failed / core_restarted；太旧的 `started` 删除。
   *
   * 两档都必须在这里收掉，因为它们是**进程内**的两样东西：`pending` 是还没交接的提交，
   * `queued` 是交给了 omp、排在它内存队列里的那一句 —— 队列随进程一起消失（R-08-5）。
   * 只收 pending 的话，排队的那些会永远停在 `queued`：界面既不画队列（队列已经没了）
   * 也不画这条提交（`queued` 不进时间线），用户根本不知道那句话没了。
   */
  recoverOnStart(): void {
    const at = this.d.clock.now()
    const error = {
      code: conversationErrors.core_restarted,
      message: conversationErrors.core_restarted,
    }
    for (const row of this.d.repo.failUndelivered(error)) {
      /* 重启后这条排队项不可能再送达：残留的上下文先摘掉，已交出的回退一次 */
      this.dropQueuedContext(row.clientTurnId, true)
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
   * 线程已删：丢掉这条线程的交接车道、待认领号与号表（库里的行已经随线程级联删除）。
   *
   * Core 是长期运行的进程，少了它，`lanes` / `pendingTurn` / `handed` / `turnIds` 会随
   * 自动化不断建线程而只增不减（R-03 §2.3、R-08-2）。
   */
  forget(threadId: string): void {
    this.lanes.delete(threadId)
    const pending = this.pendingTurn.get(threadId)
    if (pending !== undefined) this.handed.delete(pending)
    this.pendingTurn.delete(threadId)
    /* R-08-2：按线程索引的号表跟线程一起走（只增不减就是内存泄漏） */
    this.turnIds.delete(threadId)
    for (const [clientTurnId, entry] of this.queuedContexts) {
      /* 线程已删：只释放条目，不回退 —— 提供方的状态也随线程一起清掉 */
      if (entry.threadId === threadId) this.dropQueuedContext(clientTurnId, false)
    }
  }

  /** 测试用：这条线程是否还有按线程索引的状态（交接车道 / 待认领号 / 等结局的上下文） */
  has(threadId: string): boolean {
    return (
      this.lanes.has(threadId) ||
      this.pendingTurn.has(threadId) ||
      this.turnIds.has(threadId) ||
      [...this.queuedContexts.values()].some((entry) => entry.threadId === threadId)
    )
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────
  /**
   * 这条提交再也不会送达：统一摘掉排队上下文。
   *
   * 只有引擎确实收下过（`submitted`，此刻 `delivered` 已经回调）的才回退；结局先到、submit
   * 还没回来的条目从未记过已交，不能补一次 `undelivered`。线程删除等不需要回退的路径传
   * `false`，但同样要清掉条目 —— 否则 Core 长期运行会按 clientTurnId 只增不减（R-03 §2.3）。
   */
  private dropQueuedContext(clientTurnId: string, rollback: boolean): void {
    const entry = this.queuedContexts.get(clientTurnId)
    if (entry === undefined) return
    this.queuedContexts.delete(clientTurnId)
    if (rollback && entry.submitted) entry.context.undelivered()
  }

  /**
   * 新的一句进来，同线程更早的 failed 行到此为止（审查 R-20-1）：界面的 `send()` 本来就会清掉本机那份
   * 失败记录，库里的不清，下次整读又从「最后一条失败」里把横幅和「取回文字」复活出来。
   */
  private supersedeFailed(threadId: string, keep: string): void {
    for (const row of this.d.repo.listByThread(threadId)) {
      if (row.clientTurnId === keep || row.status !== 'failed') continue
      this.dropQueuedContext(row.clientTurnId, true)
      this.d.repo.delete(row.clientTurnId)
      this.d.emitRemoved({ threadId, clientTurnId: row.clientTurnId })
    }
  }

  private enqueue(threadId: string, work: () => Promise<void>): void {
    const previous = this.lanes.get(threadId)?.tail ?? Promise.resolve()
    const tail = previous.then(work).catch((cause: unknown) => {
      this.d.logger.warn('submission hand-over failed', { threadId, error: String(cause) })
    })
    this.lanes.set(threadId, { tail })
    // 车道的尾巴自己收口：不收的话每跑一条线程就永久留一项（R-03 §2.3）
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

  /** 交给 omp 的那一段（拆出来只为让复杂度落在闸门内）。 */
  private async deliver(row: SubmissionRow): Promise<void> {
    const ids = row.attachments.map((a) => a.id)
    const resolved = this.d.attachments.resolve(ids)

    const session = await this.d.acquireSession(row.threadId)
    /* 等待期间被停止 / 丢弃：不要交出去。 */
    const current = this.d.repo.get(row.clientTurnId)
    if (current === null || current.status !== 'pending') return

    /*
     * 真正按什么交出去（R-08-5）。两档都由**这一刻的会话状态**说了算，不由当初的意图说了算：
     *
     * - 会话在忙：开一轮的请求落进队列（`turn` → `followUp`）；插话与排队照旧。
     * - 会话空闲：引擎对任何投递都是开一轮（`OmpSession.submit` 只看忙不忙）。所以
     *   `retry` 一条 failed 的插话 / 排队在这里自然变回新一轮 —— 记成 `queued` 就等于
     *   把一条已经开跑的真实轮标成还在排队，界面既画不出它、也不会拿号把提交行换掉。
     */
    const deliveredAs = session.state() === 'idle' ? 'turn' : row.requestedAs === 'turn' ? 'followUp' : row.requestedAs
    this.handed.add(row.clientTurnId)
    if (deliveredAs === 'turn') this.pendingTurn.set(row.threadId, row.clientTurnId)

    const context = this.contextFor(row, deliveredAs)
    try {
      await session.submit({
        text: row.text,
        images: resolved.filter((a) => a.kind === 'image').map((a) => ({ path: a.path, mime: a.mime })),
        files: resolved.filter((a) => a.kind === 'file').map((a) => ({ path: a.path, name: a.name })),
        skills: [...row.skills],
        deliverAs: deliveredAs,
        /* 排队项的结局靠这个号对回本行（审查 R-20-1） */
        ref: row.clientTurnId,
        ...(context === null ? {} : { context: context.blocks }),
      })
    } catch (cause) {
      /* submit 抛错：这一句没送达，提供方的内容留到下一句 */
      this.dropQueuedContext(row.clientTurnId, false)
      throw cause
    }
    if (deliveredAs !== 'turn') {
      this.handOverQueuedContext(row.clientTurnId)
      /* 结局可能已经先到（送达 → 行已删 / 丢弃 → failed）：只有还停在 pending 才记成 queued */
      if (this.d.repo.get(row.clientTurnId)?.status === 'pending') this.update(row.clientTurnId, { status: 'queued' })
    } else if (this.pendingTurn.get(row.threadId) === row.clientTurnId && session.state() === 'idle') {
      /* 引擎收下又丢了（开轮没开起来）：这一句没送达，上下文也不算交出 */
      throw new AppError(conversationErrors.submit_dropped, conversationErrors.submit_dropped)
    } else {
      /* 开轮成功才算送达 */
      context?.delivered()
    }
    this.d.emitUserMessage({ threadId: row.threadId, at: this.d.clock.now() })
  }

  /** 这一句要带的上下文；排队项的结局可能在 submit 返回之前就到：先登记，settleQueued 才对得上 */
  private contextFor(row: SubmissionRow, deliveredAs: 'turn' | 'steer' | 'followUp'): CollectedContext | null {
    const collected = this.d.collectContext?.(row.threadId)
    if (collected === undefined || collected.blocks.length === 0) return null
    if (deliveredAs !== 'turn') {
      this.queuedContexts.set(row.clientTurnId, {
        threadId: row.threadId,
        context: collected,
        submitted: false,
        settled: null,
      })
    }
    return collected
  }

  /** submit 回来了：结局还没到 → 记已交、等结局；已经到了 → 送达才记，丢弃 / 撤回就当没交过 */
  private handOverQueuedContext(clientTurnId: string): void {
    const entry = this.queuedContexts.get(clientTurnId)
    if (entry === undefined) return
    if (entry.settled === null) {
      this.queuedContexts.set(clientTurnId, { ...entry, submitted: true })
      entry.context.delivered()
      return
    }
    this.dropQueuedContext(clientTurnId, false)
    if (entry.settled === 'delivered') entry.context.delivered()
  }

  /** 排队项的结局：已经记过已交的，丢弃 / 撤回就撤销；submit 还没回来的，先把结局记下 */
  private settleQueuedContext(threadId: string, clientTurnId: string, outcome: QueueOutcome): void {
    const entry = this.queuedContexts.get(clientTurnId)
    if (entry === undefined || entry.threadId !== threadId) return
    if (!entry.submitted) {
      this.queuedContexts.set(clientTurnId, { ...entry, settled: outcome })
      return
    }
    this.dropQueuedContext(clientTurnId, outcome !== 'delivered')
  }

  /** 失败结局（没送达 → failed，错误码原样存下）。 */
  private fail(clientTurnId: string, threadId: string, cause: unknown): void {
    if (this.pendingTurn.get(threadId) === clientTurnId) this.pendingTurn.delete(threadId)
    const row = this.d.repo.get(clientTurnId)
    if (row === null) return
    const mapped = toAppError(cause)
    this.markFailed(row, { code: mapped.code, message: mapped.message })
  }

  /** 唯一的「变为 failed」出口：写库、推 UI、发 Core 事件（R-06 §3.2） */
  private markFailed(row: SubmissionRow, error: { code: string; message: string }): void {
    /* 失败是「这一条再也不会送达」的收口：先回退仍挂着的排队上下文 */
    this.dropQueuedContext(row.clientTurnId, true)
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
