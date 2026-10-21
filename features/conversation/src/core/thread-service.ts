import type { AgentEngine, EngineSession, ModelRef, Posture } from '@poietica/engine'
import type { AttachmentsService } from '@poietica/feature-attachments/core-api'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import { AppError, type Clock, createId, type Logger } from '@poietica/foundation'
import type { Thread, TurnState } from '../contract/entities'
import { conversationErrors } from '../contract/errors'
import type { ReclaimRepository } from './reclaim-repository'
import type { ThreadRow, ThreadsRepository } from './repository'
import { threadOf } from './repository'
import type { TimelineHub } from './timeline-hub'
import { deriveTitle, forkTitleOf, normalizeTitle, PENDING_TITLE } from './title'

/** 附件引用的 ownerKey 拼法：'<功能 id>:<实体>:<id>' */
export const OWNER_KEY = (threadId: string): string => `conversation:thread:${threadId}`

/**
 * 线程 CRUD、fork、export、删除，以及工作区移除的级联清理。会话池的接线
 * （describe / onOpened / cleanup）也在这里 —— 「一条线程对应哪个 omp 会话」是线程自己的事实。
 */
export interface ThreadServiceDeps {
  readonly repo: ThreadsRepository
  /** 会话文件回收队列：删行与入队同一个事务（见 cleanup） */
  readonly reclaim: ReclaimRepository
  /** 本模块库的同步事务（组合根注入 `db.transaction`） */
  readonly transaction: <T>(fn: () => T) => T
  readonly engine: AgentEngine
  readonly workspaces: WorkspacesService
  readonly attachments: AttachmentsService
  readonly hub: TimelineHub
  readonly clock: Clock
  readonly logger: Logger
  /** 会话此刻的状态（来自会话池；组合根注入，避免与 turn-service 互相依赖） */
  readonly sessionState: (threadId: string) => TurnState['state']
  readonly peekSession: (threadId: string) => EngineSession | undefined
  /** 这一条线程的会话正在打开（打开中的不算忙，见 #isBusy） */
  readonly isOpening: (threadId: string) => boolean
  /** 释放这个线程的会话（delete / 工作区级联用） */
  readonly releaseSession: (threadId: string) => Promise<void>
  readonly emitThreadUpdated: (thread: Thread) => void
  readonly emitThreadRemoved: (threadId: string) => void
  /** 线程行删除后的统一遗忘钩子：清理按线程索引的进程内状态（router / submissions） */
  readonly onThreadRemoved: (threadId: string) => void
}

export class ThreadService {
  constructor(private readonly d: ThreadServiceDeps) {}

  // ── 读 ────────────────────────────────────────────────────────────────────
  row(id: string): ThreadRow | null {
    return this.d.repo.get(id)
  }

  requireRow(id: string): ThreadRow {
    const row = this.d.repo.get(id)
    if (row === null) {
      throw new AppError(conversationErrors.thread_not_found, '对话不存在')
    }
    return row
  }

  threadOf(row: ThreadRow): Thread {
    return threadOf(row, this.stateOf(row.id))
  }

  stateOf(threadId: string): TurnState['state'] {
    return this.d.sessionState(threadId)
  }

  list(q: { workspaceId?: string | undefined; includeArchived: boolean }): Thread[] {
    return this.d.repo.list(q).map((row) => this.threadOf(row))
  }

  // ── 线程 CRUD（服务行为表）───────────────────────────────────────────────
  create(init: {
    workspaceId: string
    posture?: Posture | undefined
    model?: ModelRef | undefined
    thinking?: string | undefined
    title?: string
    origin?: 'user' | 'automation'
  }): ThreadRow {
    this.d.workspaces.requireUsable(init.workspaceId)
    const now = this.d.clock.now()
    const row: ThreadRow = {
      id: createId(),
      workspaceId: init.workspaceId,
      title: init.title ?? PENDING_TITLE,
      /* 调用方给了标题（定时任务的「定时任务：<标题> <时间>」）就是定名：首句不再自动改名（审查 R-14） */
      titleSource: init.title === undefined ? 'pending' : 'user',
      posture: init.posture ?? 'auto-edit',
      origin: init.origin ?? 'user',
      sessionId: null,
      sessionFile: null,
      forkedFrom: null,
      pinned: false,
      archived: false,
      initialModel: init.model ?? null,
      initialThinking: init.thinking ?? null,
      createdAt: now,
      updatedAt: now,
    }
    this.d.repo.insert(row)
    this.emitUpdated(row)
    return row
  }

  /**
   * 用户改名：**先写进 omp**（会话名的唯一产地，P4），再改行。开着的会话走 `session.rename`（omp 的 setSessionName，
   * 与 RPC `set_session_name` 同一条路），没开着的直接改会话文件头；还没有会话文件（一句话都没发）的只改行，
   * 等会话第一次打开时由 `onOpened` 补写进去。omp 记下 user 来源之后自己就不会再自动起名。
   */
  async rename(id: string, title: string): Promise<ThreadRow> {
    const row = this.requireRow(id)
    const next = normalizeTitle(title)
    const live = this.d.peekSession(id)
    if (live !== undefined) await live.rename(next)
    else if (row.sessionFile !== null) await this.d.engine.sessionFiles.rename(row.sessionFile, next)
    /*
     * 改名不是活动：**不碰 updatedAt**。侧栏那格「N 分钟前」与排序读的都是它，
     * 改个名字就让对话跳到「现在」是把元数据编辑当成了对话活动（产品负责人
     * 2026-10-12 报告的真实缺陷）。
     */
    this.d.repo.update(id, { title: next, titleSource: 'user' })
    return this.emitUpdated({ ...row, title: next, titleSource: 'user' })
  }

  setPinned(id: string, pinned: boolean): ThreadRow {
    const row = this.requireRow(id)
    this.d.repo.update(id, { pinned })
    return this.emitUpdated({ ...row, pinned })
  }

  setArchived(id: string, archived: boolean): ThreadRow {
    const row = this.requireRow(id)
    this.d.repo.update(id, { archived })
    return this.emitUpdated({ ...row, archived })
  }

  setPosture(id: string, posture: Posture): void {
    const row = this.d.repo.get(id)
    if (row === null || row.posture === posture) return
    this.d.repo.update(id, { posture })
    this.emitUpdated({ ...row, posture })
  }

  /**
   * 第一条消息落地时按正文起标题（只从 `pending` 起一次）。
   *
   * 起标题的时机是**一条 `turn` 提交被存下**（提交可能在后台排队很久），所以住在提交服务
   * 调用的这里，而不是 TurnService 的 submit 里。
   */
  autoTitle(threadId: string, text: string): void {
    const row = this.d.repo.get(threadId)
    if (row === null || row.titleSource !== 'pending') return
    const title = deriveTitle(text)
    const now = this.d.clock.now()
    this.d.repo.update(threadId, { title, titleSource: 'auto', updatedAt: now })
    this.emitUpdated({ ...row, title, titleSource: 'auto', updatedAt: now })
  }

  /**
   * omp 的会话名变了（omp 知识 #17）。omp 是会话名的唯一产地，行里那一格只是它的投影：
   * - `user`（GUI 改名回声、`/rename` 命令、重开时 omp 报回的定名）→ 照抄，来源记 user，**不碰 updatedAt**（改名不是活动）；
   * - `auto`（自动总结）→ 替换首句兜底；行已是 user 时不覆盖（omp 自己也会拒，这里挡的是迟到事件）。
   *
   * 共同守卫：行没了 → 无事可做；`sessionFile` 对不上（线程被驱逐重开 / 换过分支）→ 旧会话的迟到事件；
   * 空标题或与当前完全相同 → 不产生一次假更新。
   */
  setTitleFromSession(threadId: string, title: string, source: 'auto' | 'user', sessionFile: string): void {
    const row = this.d.repo.get(threadId)
    if (row === null || row.sessionFile !== sessionFile) return
    const next = normalizeTitle(title)
    if (next === '' || (next === row.title && row.titleSource === source)) return
    if (source === 'user') {
      this.d.repo.update(threadId, { title: next, titleSource: 'user' })
      this.emitUpdated({ ...row, title: next, titleSource: 'user' })
      return
    }
    if (row.titleSource === 'user' || next === row.title) return
    const now = this.d.clock.now()
    this.d.repo.update(threadId, { title: next, titleSource: 'auto', updatedAt: now })
    this.emitUpdated({ ...row, title: next, titleSource: 'auto', updatedAt: now })
  }

  /** 会话池问路：这一条线程的 cwd、会话文件、姿态、初始模型（describe） */
  describe(threadId: string): import('@poietica/engine').OpenSessionSpec {
    const row = this.requireRow(threadId)
    const ws = this.d.workspaces.requireUsable(row.workspaceId)
    return {
      key: threadId,
      cwd: ws.path,
      sessionFile: row.sessionFile,
      posture: row.posture,
      model: row.initialModel,
      thinking: row.initialThinking,
      /*
       * 谁可以再被 omp 总结一次（omp 知识 #17）：**只有用户定过名的不许**。
       *
       * 判据不能用 `=== 'pending'`：describe 是在兜底标题写进之后才被调用的
       * （提交存下 → autoTitle 写首句 → 交接时开会话），那一刻 titleSource 已经是 `auto`，
       * 用 pending 判会让 omp 一次都不被触发（实测：总结永远不生效）。`auto` 表示「这行
       * 的标题是可被总结替换的兜底/自动值」，`user` 才是用户的定名。
       */
      autoTitle: row.titleSource !== 'user',
    }
  }

  /** 新会话第一次打开后：把 sessionId / sessionFile 绑到线程行；已有通道则换 epoch */
  onOpened(threadId: string, session: EngineSession): void {
    const row = this.d.repo.get(threadId)
    if (row === null) return
    // 发过增量的通道（会话被驱逐后又打开）→ 换 epoch，UI 整页重取；只被冷读订阅过的通道不换（见 TimelineHub.resetAdvanced）
    this.d.hub.resetAdvanced(threadId)
    if (row.sessionFile !== session.sessionFile) {
      // session_id 与 session_file 必须同时写（库里的 CHECK 约束）
      this.d.repo.update(threadId, { sessionId: session.sessionId, sessionFile: session.sessionFile })
      const next = { ...row, sessionId: session.sessionId, sessionFile: session.sessionFile }
      this.emitUpdated(next)
      /* 会话文件出现之前就定过名（一句话都没发就改名）：第一次绑上会话时补写进 omp，之后两边同一个名字 */
      if (row.sessionFile === null && row.titleSource === 'user') {
        session.rename(row.title).catch((error: unknown) => {
          this.d.logger.warn('session rename on open failed', { threadId, error: String(error) })
        })
      }
    }
  }

  /**
   * 会话释放（空闲驱逐 / 关闭）后：丢掉该线程的补发历史，并把行再报一次，
   * 让 state 从 running 回到 idle（R-05 §3.2）。
   *
   * 历史不能留：op 里可能有内联图片（base64 data URL）与长工具输出，会话释放后这份缓存会
   * 随线程活到进程结束。不动 epoch、不发 reset —— 那会立刻触发整读。
   */
  onReleased(threadId: string): void {
    this.d.hub.dropHistory(threadId)
    const row = this.d.repo.get(threadId)
    if (row !== null) this.emitUpdated(row)
  }

  async delete(threadId: string): Promise<void> {
    const row = this.requireRow(threadId)
    if (await this.#isBusy(threadId)) {
      throw new AppError(conversationErrors.thread_busy, '对话正在运行，请先停止')
    }
    await this.cleanup(row)
    this.d.emitThreadRemoved(threadId)
  }

  /** `keepTurns`：只留前几轮（时间线上的轮号）；不给 = 整条复制 */
  async fork(threadId: string, keepTurns: number | undefined, title?: string): Promise<ThreadRow> {
    const row = this.requireRow(threadId)
    if (await this.#isBusy(threadId)) {
      throw new AppError(conversationErrors.thread_busy, '对话正在运行，请先停止')
    }
    if (row.sessionFile === null) {
      throw new AppError(conversationErrors.thread_empty, '对话还没有任何内容')
    }
    /* 分叉的名字一并写进 omp 的新会话（P4）：行里的标题只是它的投影 */
    const forkTitle = normalizeTitle(title ?? forkTitleOf(row.title))
    const forked = await this.d.engine.sessionFiles.fork(row.sessionFile, keepTurns, forkTitle)
    const now = this.d.clock.now()
    const next: ThreadRow = {
      ...row,
      id: createId(),
      title: forkTitle,
      titleSource: 'user',
      sessionId: forked.sessionId,
      sessionFile: forked.sessionFile,
      forkedFrom: row.id,
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    }
    try {
      this.d.repo.insert(next)
    } catch (error) {
      /* 副本已经落盘、行却没写进去：没有线程认领它。入回收队列再删 —— 删不掉留给下次启动，不在磁盘上留一份孤儿 */
      this.d.reclaim.enqueue(forked.sessionFile, next.id, now)
      await this.reclaimFile(forked.sessionFile)
      throw error
    }
    /*
     * R-07 §3.3：分支继承了历史，也就要继承历史里那些附件的引用。
     * 少了这一句，删掉原对话（releaseOwner）后 24 小时的回收会把文件删掉，
     * 分支里的 agent 再按路径去读就读不到了。
     */
    this.d.attachments.copyOwner(OWNER_KEY(row.id), OWNER_KEY(next.id))
    this.emitUpdated(next)
    return next
  }

  async exportThread(threadId: string, format: 'html' | 'markdown', targetPath: string): Promise<{ path: string }> {
    const row = this.requireRow(threadId)
    if (row.sessionFile === null) {
      throw new AppError(conversationErrors.thread_empty, '对话还没有任何内容')
    }
    if (format === 'html') {
      await this.d.engine.sessionFiles.exportHtml(row.sessionFile, targetPath)
      return { path: targetPath }
    }
    const markdown = await this.d.engine.sessionFiles.exportMarkdown(row.sessionFile)
    const { writeFileAtomic } = await import('@poietica/fs-kit')
    await writeFileAtomic(targetPath, markdown)
    return { path: targetPath }
  }

  /**
   * 分享：交给引擎的 omp /share（加密快照 + 查看器链接）。空会话没有会话文件可分享，报 thread_empty；
   * 链接的生成与脱敏都在引擎那一侧，Core 只负责把线程行上的会话文件找出来。
   */
  async shareThread(threadId: string): Promise<{ url: string; truncated: boolean }> {
    const row = this.requireRow(threadId)
    if (row.sessionFile === null) {
      throw new AppError(conversationErrors.thread_empty, '对话还没有任何内容')
    }
    return await this.d.engine.sessionFiles.share(row.sessionFile)
  }

  /** 工作区被移除：该工作区的每个线程都走一遍 delete 的清理（运行中的先取消） */
  async removeWorkspaceThreads(workspaceId: string): Promise<void> {
    for (const row of this.d.repo.listByWorkspace(workspaceId)) {
      const session = this.d.peekSession(row.id)
      if (session?.isBusy() === true) await session.cancel().catch(() => undefined)
      await this.cleanup(row).catch((e: unknown) => {
        this.d.logger.warn('workspace cascade cleanup failed', { threadId: row.id, error: String(e) })
      })
      this.d.emitThreadRemoved(row.id)
    }
  }

  /**
   * delete 的清理部分（R-03 §2.3）：释放会话（打开中的取消也会等到收尾）→ 重读行拿
   * sessionFile（打开期间可能已被 onOpened 写上，传进来的 row 是旧的）→ **删行并把会话文件记进回收队列（同一个事务）**
   * → hub.disposeThread → 遗忘进程内状态 → 释放附件 → 尝试物理回收。
   *
   * 「线程删了没有」只看库里那一行：它与「这份文件待回收」一起落账，之后的步骤失败都不再让线程卡在半删状态。
   * 原先按「先删文件、再删行」串着做：文件那一步一抛（omp 从没落过盘 → session_file_missing），行就永远删不掉；
   * 文件删掉了而后面某一步失败，再删一次又会因为文件已不在而失败（真实故障：归档页「删除失败，请重试。」）。
   */
  private async cleanup(row: ThreadRow): Promise<void> {
    await this.d.releaseSession(row.id)
    const current = this.d.repo.get(row.id) ?? row
    const sessionFile = current.sessionFile
    this.d.transaction(() => {
      this.d.repo.delete(row.id)
      if (sessionFile !== null) this.d.reclaim.enqueue(sessionFile, row.id, this.d.clock.now())
    })
    this.d.hub.disposeThread(row.id)
    this.d.onThreadRemoved(row.id)
    /* 附件引用放在落账之后：放在前面，删行失败时线程还在、附件却被 24 小时回收清掉（分支里的 agent 就读不到了） */
    try {
      this.d.attachments.releaseOwner(OWNER_KEY(row.id))
    } catch (error) {
      this.d.logger.warn('attachments release on delete failed', { threadId: row.id, error: String(error) })
    }
    if (sessionFile !== null) await this.reclaimFile(sessionFile)
  }

  /** 物理回收一份会话文件：成功出队；失败记账、留给下次启动重试，**不抛** —— 线程在用户看来已经删完了 */
  private async reclaimFile(sessionFile: string): Promise<boolean> {
    try {
      await this.d.engine.sessionFiles.delete(sessionFile)
      this.d.reclaim.done(sessionFile)
      return true
    } catch (error) {
      this.d.reclaim.failed(sessionFile, String(error), this.d.clock.now())
      this.d.logger.warn('session file reclaim failed; will retry on next start', { sessionFile, error: String(error) })
      return false
    }
  }

  /** 回收队列重试（启动时跑一次）：上次没删掉的会话文件（被占用、权限、进程在删到一半时退出）再删一遍 */
  async reclaimPending(): Promise<{ reclaimed: number; failed: number }> {
    let reclaimed = 0
    let failed = 0
    for (const entry of this.d.reclaim.pending()) {
      if (await this.reclaimFile(entry.sessionFile)) reclaimed += 1
      else failed += 1
    }
    if (reclaimed + failed > 0) this.d.logger.info('session file reclaim', { reclaimed, failed })
    return { reclaimed, failed }
  }

  /**
   * 启动对账：行上绑着的会话文件必须真的在。不在的（升级前留下的：会话打开就绑了路径，omp 却要等第一条回复才落盘）
   * 把绑定清掉，让这条线程回到「还没有会话」—— 下次打开新建一条，而不是每次都报 session_file_missing。
   * 文件里本来就没有任何东西，清掉绑定不丢数据。正在打开 / 已打开的跳过（启动时不会有，防御性的）。
   */
  async reconcileSessionFiles(): Promise<{ unbound: number }> {
    let unbound = 0
    for (const bound of this.d.repo.listBound()) {
      if (this.d.isOpening(bound.id) || this.d.peekSession(bound.id) !== undefined) continue
      let exists: boolean
      try {
        exists = await this.d.engine.sessionFiles.exists(bound.sessionFile)
      } catch (error) {
        /* 读不了（权限 / 盘符没挂上）不等于不存在：不动它 */
        this.d.logger.warn('session file check failed', { threadId: bound.id, error: String(error) })
        continue
      }
      if (exists) continue
      this.d.repo.update(bound.id, { sessionId: null, sessionFile: null })
      unbound += 1
    }
    if (unbound > 0) this.d.logger.info('unbound threads whose session file never materialized', { unbound })
    return { unbound }
  }

  /**
   * 活会话的**主对话**在忙才算忙。打开中的**不算忙**：删除 / fork 允许继续，删除由 `release` 的取消
   * 语义保证打开完成后立刻丢弃（R-03 §2.3）。
   *
   * 读 `state()` 而不是 `isBusy()`：后者把右坞里正在答的侧边提问也算进去（那是给会话池看的「别回收」），
   * 而侧边一问不该拦住删除与分叉 —— 删除时它随会话一起停掉，分叉复制的是已经落盘的话题。
   */
  async #isBusy(threadId: string): Promise<boolean> {
    if (this.d.isOpening(threadId)) return false
    const state = this.d.peekSession(threadId)?.state()
    return state !== undefined && state !== 'idle'
  }

  private emitUpdated(row: ThreadRow): ThreadRow {
    this.d.emitThreadUpdated(this.threadOf(row))
    return row
  }
}
