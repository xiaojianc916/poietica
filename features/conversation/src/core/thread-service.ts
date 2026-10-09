import type { AgentEngine, EngineSession, ModelRef, Posture } from '@poietica/engine'
import type { AttachmentsService } from '@poietica/feature-attachments/core-api'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import { AppError, type Clock, createId, type Logger } from '@poietica/foundation'
import { MAIN_AGENT_ID, type Thread, type TurnState } from '../contract/entities'
import { conversationErrors } from '../contract/errors'
import type { ThreadRow, ThreadsRepository } from './repository'
import { threadOf } from './repository'
import type { TimelineHub } from './timeline-hub'
import { deriveTitle, normalizeTitle, PENDING_TITLE } from './title'

/** 附件引用的 ownerKey 拼法（07 页 §4C 的约定：'<功能 id>:<实体>:<id>'） */
export const OWNER_KEY = (threadId: string): string => `conversation:thread:${threadId}`

/**
 * 线程服务（07 页 §5C 的 `thread-service.ts`）：线程 CRUD、fork、export、删除，
 * 以及工作区移除的级联清理。会话池的接线（describe / onOpened / cleanup）也在这里 ——
 * 「一条线程对应哪个 omp 会话」是线程自己的事实。
 */
export interface ThreadServiceDeps {
  readonly repo: ThreadsRepository
  readonly engine: AgentEngine
  readonly workspaces: WorkspacesService
  readonly attachments: AttachmentsService
  readonly hub: TimelineHub
  readonly clock: Clock
  readonly logger: Logger
  /** 会话此刻的状态（来自会话池；组合根注入，避免与 turn-service 互相依赖） */
  readonly sessionState: (threadId: string) => TurnState['state']
  /** 会话池里这一条线程此刻的会话（没有就是 undefined） */
  readonly peekSession: (threadId: string) => EngineSession | undefined
  /** 释放这个线程的会话（delete / 工作区级联用） */
  readonly releaseSession: (threadId: string) => Promise<void>
  /** 会话被驱逐（空闲）后把线程行再报一次 */
  readonly onSessionReleased: (threadId: string) => void
  readonly emitThreadUpdated: (thread: Thread) => void
  readonly emitThreadRemoved: (threadId: string) => void
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

  // ── 线程 CRUD（07 页 §5C 服务行为表）──────────────────────────────────────
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
      titleSource: 'pending',
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

  rename(id: string, title: string): ThreadRow {
    const row = this.requireRow(id)
    const next = normalizeTitle(title)
    this.d.repo.update(id, { title: next, titleSource: 'user', updatedAt: this.d.clock.now() })
    return this.emitUpdated({ ...row, title: next, titleSource: 'user', updatedAt: this.d.clock.now() })
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
   * 第一条消息落地时按正文起标题（07 页 §5C；只从 `pending` 起一次）。
   *
   * 原先这段住在 TurnService 的 submit 里；「Core 即时回显」之后，起标题的时机是
   * **一条 `turn` 提交被存下**（提交可能在后台排队很久），所以挪到线程自己的服务上，
   * 由提交服务调用。
   */
  autoTitle(threadId: string, text: string): void {
    const row = this.d.repo.get(threadId)
    if (row === null || row.titleSource !== 'pending') return
    const title = deriveTitle(text)
    const now = this.d.clock.now()
    this.d.repo.update(threadId, { title, titleSource: 'auto', updatedAt: now })
    this.emitUpdated({ ...row, title, titleSource: 'auto', updatedAt: now })
  }

  /** 会话池问路：这一条线程的 cwd、会话文件、姿态、初始模型（07 页 §5C 的 describe） */
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
    }
  }

  /** 新会话第一次打开后：把 sessionId / sessionFile 绑到线程行；已有通道则换 epoch */
  onOpened(threadId: string, session: EngineSession): void {
    const row = this.d.repo.get(threadId)
    if (row === null) return
    // 线程已有通道（会话被驱逐后又打开）→ 换 epoch，UI 整页重取
    if (this.d.hub.has(threadId, MAIN_AGENT_ID)) this.d.hub.resetThread(threadId)
    if (row.sessionFile !== session.sessionFile) {
      // session_id 与 session_file 必须同时写（08 页 §5.2 的 CHECK）
      this.d.repo.update(threadId, { sessionId: session.sessionId, sessionFile: session.sessionFile })
      const next = { ...row, sessionId: session.sessionId, sessionFile: session.sessionFile }
      this.emitUpdated(next)
    }
  }

  /** 会话释放（空闲驱逐 / 关闭）后把行再报一次，让 state 从 running 回到 idle */
  onReleased(threadId: string): void {
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

  async fork(threadId: string, undoTurns: number, title?: string): Promise<ThreadRow> {
    const row = this.requireRow(threadId)
    if (await this.#isBusy(threadId)) {
      throw new AppError(conversationErrors.thread_busy, '对话正在运行，请先停止')
    }
    if (row.sessionFile === null) {
      throw new AppError(conversationErrors.thread_empty, '对话还没有任何内容')
    }
    const forked = await this.d.engine.sessionFiles.fork(row.sessionFile, undoTurns)
    const now = this.d.clock.now()
    const next: ThreadRow = {
      ...row,
      id: createId(),
      title: title ?? `${row.title}（分支）`,
      titleSource: 'user',
      sessionId: forked.sessionId,
      sessionFile: forked.sessionFile,
      forkedFrom: row.id,
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    }
    this.d.repo.insert(next)
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

  /** delete 的清理部分：会话文件 → 附件引用 → 删行 → hub.disposeThread */
  private async cleanup(row: ThreadRow): Promise<void> {
    await this.d.releaseSession(row.id)
    if (row.sessionFile !== null) await this.d.engine.sessionFiles.delete(row.sessionFile)
    this.d.attachments.releaseOwner(OWNER_KEY(row.id))
    this.d.repo.delete(row.id)
    this.d.hub.disposeThread(row.id)
  }

  async #isBusy(threadId: string): Promise<boolean> {
    return this.d.peekSession(threadId)?.isBusy() === true
  }

  private emitUpdated(row: ThreadRow): ThreadRow {
    this.d.emitThreadUpdated(this.threadOf(row))
    return row
  }
}
