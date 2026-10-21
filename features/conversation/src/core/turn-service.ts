import {
  type AgentEngine,
  type Controls,
  EngineErrorCode,
  type EngineSession,
  type Interaction,
  type InteractionAnswer,
  type ModelRef,
  type Posture,
  type QueueSnapshot,
  type SideTopic,
  type SlashCommand,
} from '@poietica/engine'
import type { AttachmentsService } from '@poietica/feature-attachments/core-api'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import { AppError, type Clock, type Logger, SystemErrorCode } from '@poietica/foundation'
import type { TranscriptPage } from '@poietica/transcript'
import type { QueueView } from '../contract'
import { DEFAULT_POSTURE, type Thread, type TurnState } from '../contract/entities'
import { conversationErrors } from '../contract/errors'
import { controlsFromSnapshot } from './controls-snapshot'
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

/** 没开着的会话的队列：空，两档模式是每条新会话的起点（与引擎 OmpSession 的初值同一份） */
const IDLE_QUEUE: QueueSnapshot = { items: [], modes: { steer: 'all', followUp: 'all' } }

export class TurnService {
  constructor(private readonly d: TurnServiceDeps) {}

  // ── 会话池的三个口（供 handlers / 组合根用；读时间线不在这里取会话，见 page）────────────
  peek(threadId: string): EngineSession | undefined {
    return this.d.pool.peek(threadId)
  }

  /**
   * 预热（threads.open）：**写意图**才来 —— UI 在人开始写这一句（输入框拿到焦点、拖进文件）时发，第一句话发出去时会话已经开好。
   * 读（时间线、控件、队列、命令、侧边话题）一律不经过这里，看一眼历史对话不开会话（性能方案 P1 / P4）。
   */
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

  /** 配置变更 → 会话池换代（R-03；调用方同步改名） */
  async invalidateSessions(): Promise<void> {
    await this.d.pool.invalidate()
  }

  // ── 回合（服务行为表）────────────────────────────────────────────────────
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
     */ return { submission: this.d.submissions.submit(input) }
  }

  async cancel(threadId: string): Promise<void> {
    /* 还没交给 omp 的 pending 直接收成 failed / submit_cancelled。 */
    this.d.submissions.cancelUnhanded(threadId)
    const session = this.d.pool.peek(threadId)
    if (session === undefined) return
    this.d.router.requestCancel(threadId)
    await session.cancel()
  }

  /** 时间线订阅要画的提交行（线程还没有会话时也要返回）。 */
  submissionsOf(threadId: string, stamped: ReadonlySet<string>): import('../contract').SubmissionView[] {
    return this.d.submissions.viewOfThread(threadId, stamped)
  }

  // ── 时间线（timeline 三段）───────────────────────────────────────────────
  /** 空页：线程还没落过盘（行上没有会话文件）时 page 交它 —— 没有正文可读，也不为一次读去签发会话文件 */
  private emptyPage(): TranscriptPage {
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

  /**
   * 时间线的一页 —— **读不开会话**（读写分离，性能方案 P1）。
   *
   * 会话开着就问它：正在流式的那一截只有它知道。不在池里（包括正在打开）就冷读会话文件
   * （`SessionFilesPort.readPage`，与「重开再 page()」同一页）：看一眼历史对话、往上翻页、定时任务从线程预填，
   * 都不再冷启动一整条 AgentSession —— 那要装工具与扩展、按会话拉起全部 MCP 服务器，而且引擎里所有打开排成一队。
   * 打开中的也冷读：打开不改文件里已有的正文（中断修补在冷读里按同一口径补齐），打开之后的变化经增量补上，
   * 只被冷读订阅过的通道打开时也不换代（TimelineHub.resetAdvanced）。
   * 还没落过盘的线程没有正文可读：空页，不为一次读去签发会话文件。
   */
  async page(threadId: string, agentId: string, beforeTurnId: string | null): Promise<TranscriptPage> {
    const live = this.d.pool.peek(threadId)
    if (live !== undefined) return await live.page(agentId, beforeTurnId)
    const { sessionFile } = this.d.requireRow(threadId)
    if (sessionFile === null) return this.emptyPage()
    return await this.d.engine.sessionFiles.readPage(sessionFile, agentId, beforeTurnId)
  }

  // ── 队列（queue 三方法）──────────────────────────────────────────────────
  /**
   * 队列快照 —— **读不开会话**（性能方案 P4）。队列只活在活会话的内存里：没开着的会话一定是空队列，
   * 两档模式也是新会话的起点（引擎每条会话都从 all / all 起，不落盘）—— 与「为这一读打开会话再问」逐字相同。
   */
  async queue(threadId: string): Promise<QueueView> {
    const live = this.d.pool.peek(threadId)
    if (live !== undefined) return this.queueViewOf(threadId, live)
    this.d.requireRow(threadId)
    return this.d.submissions.queueViewOf(threadId, IDLE_QUEUE)
  }

  /** 队列只从这里出去：引擎快照挂上提交行的附件，界面才画得出缩略图（见 SubmissionService.queueViewOf） */
  private queueViewOf(threadId: string, session: EngineSession): QueueView {
    return this.d.submissions.queueViewOf(threadId, session.queue())
  }

  async withdraw(threadId: string, itemId: string): Promise<QueueView> {
    /*
     * 队列只存在于活会话里（peek 不 acquire）：为撤回一条排队项去冷启动一条会话没有意义，
     * 冷启动出来的队列一定是空的。没有活会话就是「队列里没有这一项」。
     */
    const session = this.d.pool.peek(threadId)
    if (session === undefined) throw new AppError(SystemErrorCode.notFound, '队列里没有这一项')
    session.withdraw(itemId)
    return this.queueViewOf(threadId, session)
  }

  /**
   * 换层（steer ⇄ followUp）：同样只对活会话操作，用账本里的原始输入重新入队，
   * 附件与技能一样不丢（R-01 §3.8）。已被 agent 消费的项由引擎抛
   * `engine.queue_item_consumed`，这里原样放行。
   */
  async move(threadId: string, itemId: string, deliverAs: 'steer' | 'followUp'): Promise<QueueView> {
    const session = this.d.pool.peek(threadId)
    if (session === undefined) throw new AppError(SystemErrorCode.notFound, '队列里没有这一项')
    await session.moveQueued(itemId, deliverAs)
    return this.queueViewOf(threadId, session)
  }

  // ── 子代理与后台作业（状态弹窗 / 子代理标签页的停止与引导）────────────────────────
  /*
   * 与撤回同一条理由：跑着的子代理、后台作业只活在活会话里（peek 不 acquire）—— 为停一个子代理去冷启动会话，
   * 冷启动出来的会话里它一定已经不在跑了。没有活会话就是「它已经结束了」。
   */
  async cancelSubagent(threadId: string, agentId: string): Promise<boolean> {
    return (await this.d.pool.peek(threadId)?.cancelSubagent(agentId)) ?? false
  }

  async steerSubagent(threadId: string, agentId: string, text: string): Promise<void> {
    const session = this.d.pool.peek(threadId)
    if (session === undefined) throw new AppError(EngineErrorCode.subagentNotRunning, '这个子代理已经结束了')
    await session.steerSubagent(agentId, text)
  }

  async cancelBackgroundTask(threadId: string, taskId: string): Promise<boolean> {
    return (await this.d.pool.peek(threadId)?.cancelBackgroundTask(taskId)) ?? false
  }

  async setQueueModes(threadId: string, modes: Partial<QueueSnapshot['modes']>): Promise<QueueView> {
    const session = await this.d.pool.acquire(threadId)
    session.setQueueModes(modes)
    return this.queueViewOf(threadId, session)
  }

  // ── 控件（controls 六方法 + 草稿）────────────────────────────────────────
  /**
   * 控件表 —— **读不开会话**（性能方案 P4）。会话开着就问它；没开着：
   * - 还没落过盘（行上没有会话文件）：草稿表，按行上记的初始模型 / 档位 / 姿态 —— 打开时 describe 交给引擎的正是这三格；
   * - 落过盘：控件表快照（会话最后一次报的模型、档位、计划、目标、上下文）配上现读的候选与可用性（controls-snapshot.ts）；
   * - 落过盘却没有快照（升级前的线程、分叉出来的新线程）：照旧打开会话现问 —— 打开时快照写进来，下一次就是冷读。
   * 会话打开时 Core 主动推一次真值（controls.changed），冷读与真值有出入（模型下架被换掉）也只差到那一刻。
   */
  async controls(threadId: string): Promise<Controls> {
    const live = this.d.pool.peek(threadId)
    if (live !== undefined) return live.controls()
    const row = this.d.requireRow(threadId)
    if (row.sessionFile === null) {
      return await this.d.engine.draftControls({
        model: row.initialModel,
        thinking: row.initialThinking,
        posture: row.posture,
      })
    }
    const snapshot = this.d.repo.controlsSnapshot(threadId)
    if (snapshot === null) return (await this.d.pool.acquire(threadId)).controls()
    const draft = await this.d.engine.draftControls({
      model: snapshot.model,
      thinking: snapshot.thinking.current,
      posture: row.posture,
    })
    return controlsFromSnapshot(snapshot, draft, row.posture)
  }

  /**
   * 入口那一格（还没有对话）的**草稿**控件表。
   *
   * `controls.get` 的免会话版本：**不开会话、不写设置、不碰文件**，只是把引擎那一支
   * `draftControls` 转发出去。`init` 只决定哪一格被选中（还没落账的草稿），不改全局默认；
   * 改默认走 `setDraftDefault`。
   */
  async draftControls(init: {
    model: ModelRef | null
    thinking: string | null
    posture: Posture | null
    hidden?: readonly string[] | undefined
  }): Promise<Controls> {
    return this.d.engine.draftControls({
      model: init.model,
      thinking: init.thinking,
      posture: init.posture ?? DEFAULT_POSTURE,
      ...(init.hidden === undefined ? {} : { hidden: init.hidden }),
    })
  }

  /**
   * 入口页的选择写穿「新对话默认」那一份意图（引擎的 `modelRoles.default:档位`）。只改档位时
   * （`model` 为 null）用草稿表同一条规矩解出此刻显示的模型 —— 意图里写的必须是人看见的那一条，
   * 不能是另一处兜底挑出来的。解不出（目录为空）就没有可写的意图，如实报错。
   */
  async setDraftDefault(input: {
    model: ModelRef | null
    thinking?: string | null
    hidden?: readonly string[]
  }): Promise<void> {
    const model =
      input.model ??
      (
        await this.d.engine.draftControls({
          model: null,
          ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
        })
      ).model.current
    if (model === null) throw new AppError(SystemErrorCode.invalidParams, '没有可用的模型，无法写入默认选择')
    await this.d.engine.models.setDefaultModel(model, input.thinking)
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

  async pauseGoal(threadId: string): Promise<Controls> {
    const session = await this.d.pool.acquire(threadId)
    await session.pauseGoal()
    return session.controls()
  }

  async resumeGoal(threadId: string): Promise<Controls> {
    const session = await this.d.pool.acquire(threadId)
    await session.resumeGoal()
    return session.controls()
  }

  // ── 斜杠命令（表与执行都归引擎，这里只拿会话转交）──────────────────────────
  /**
   * 命令表 —— **读不开会话**（性能方案 P4）。会话开着就问它（含扩展、自定义 TS 命令与 MCP 提示词）；
   * 没开着交不开会话的那张表（内置 + 工作区的文件命令），落过盘的对话连「压缩、重试」这类只对已有对话有意义的也列上。
   * 会话打开时 Core 发 commands.changed，UI 重读就换成活会话那张。
   */
  async commands(threadId: string): Promise<readonly SlashCommand[]> {
    const live = this.d.pool.peek(threadId)
    if (live !== undefined) return await live.commands()
    const row = this.d.requireRow(threadId)
    const cwd = this.d.workspaces.requireUsable(row.workspaceId).path
    return await this.d.engine.commandCatalog(cwd, { history: row.sessionFile !== null })
  }

  /** 入口页的命令表：不开会话，文件命令按工作区目录读（没给工作区就只有内置命令） */
  async commandCatalog(workspaceId: string | undefined): Promise<readonly SlashCommand[]> {
    const cwd = workspaceId === undefined ? null : this.d.workspaces.requireUsable(workspaceId).path
    return await this.d.engine.commandCatalog(cwd)
  }

  async runCommand(threadId: string, text: string): Promise<void> {
    const session = await this.d.pool.acquire(threadId)
    await session.runCommand(text)
  }

  // ── 侧边提问（右坞「辅助对话」，omp 的 /btw）────────────────────────────────
  /*
   * 问一句要会话（acquire）：答案拿的就是这条会话的模型、系统提示与历史快照。
   * 进行中由引擎拒绝（engine.side_busy）；问题的空白已在契约层收掉。
   */
  async askSide(threadId: string, question: string, topicId: string | null): Promise<SideTopic> {
    const session = await this.d.pool.acquire(threadId)
    return await session.askSide(question, topicId)
  }

  /** 与 cancelSubagent 同一条理由：正在答的侧边提问只活在活会话里，没有活会话就是「没有在答的」。 */
  cancelSide(threadId: string, topicId: string | null): boolean {
    return this.d.pool.peek(threadId)?.cancelSide(topicId) ?? false
  }

  /**
   * 话题表 —— **读不开会话**（性能方案 P4）。会话开着就问它（正在答的那一问只有它知道）；没开着就冷读会话产物目录里的
   * 话题存档（`SessionFilesPort.sideTopics`，与「重开再问」同一张表）。还没落过盘的线程没有话题可读：空表。
   */
  async sideTopics(threadId: string): Promise<readonly SideTopic[]> {
    const live = this.d.pool.peek(threadId)
    if (live !== undefined) return await live.sideTopics()
    const { sessionFile } = this.d.requireRow(threadId)
    if (sessionFile === null) return []
    return await this.d.engine.sessionFiles.sideTopics(sessionFile)
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
  stateOf(threadId: string): TurnState['state'] {
    return this.d.pool.peek(threadId)?.state() ?? 'idle'
  }
}
