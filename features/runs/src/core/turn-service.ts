import {
  EMPTY_THREAD_STATE,
  prependOlder,
  reduceAll,
  snapshotOf,
  type TranscriptPage,
  turnOrdinal,
} from '@poietica/agent-model'
import { AppError, type Clock, type Logger, SystemErrorCode } from '@poietica/foundation'
import type { QueueView, SubmissionView } from '@poietica/product-model'
import { controlsFromSnapshot, DEFAULT_POSTURE, type TurnState } from '@poietica/product-model'
import {
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
} from '@poietica/runtime-protocol'
import type { TurnServicePorts } from '../core-api'
import { TurnErrorCode } from '../core-api'
import { eventsFromPage, pagesToPage } from './journal-rebuild'

/**
 * 回合服务（07 页 §5C 的 `turn-service.ts`）：submit / cancel / queue / controls / interactions，
 * 以及时间线的三段读（page / subscribe / catchUp 的数据面）。
 */
interface TurnServiceBaseDeps {
  readonly clock: Clock
  readonly logger: Logger
}

/** 没开着的会话的队列：空，两档模式是每条新会话的起点（与引擎 OmpSession 的初值同一份） */
const IDLE_QUEUE: QueueSnapshot = { items: [], modes: { steer: 'all', followUp: 'all' } }

export class TurnService {
  private p!: TurnServicePorts
  constructor(private readonly d: TurnServiceBaseDeps) {}

  configure(ports: TurnServicePorts): void {
    this.p = ports
  }

  // ── 会话池的三个口（供 handlers / 组合根用；读时间线不在这里取会话，见 page）────────────
  peek(threadId: string): EngineSession | undefined {
    return this.p.pool.peek(threadId)
  }

  /**
   * 预热（threads.open）：**写意图**才来 —— UI 在人开始写这一句（输入框拿到焦点、拖进文件）时发，第一句话发出去时会话已经开好。
   * 读（时间线、控件、队列、命令、侧边话题）一律不经过这里，看一眼历史对话不开会话（性能方案 P1 / P4）。
   */
  async open(threadId: string): Promise<void> {
    this.p.threads.requireRow(threadId)
    await this.p.pool.acquire(threadId).catch((e: unknown) => {
      this.d.logger.warn('session prewarm failed', { threadId, error: String(e) })
      return undefined
    })
  }

  async close(threadId: string): Promise<void> {
    const session = this.p.pool.peek(threadId)
    if (session === undefined || session.isBusy()) return
    await this.p.pool.release(threadId)
  }

  /** 配置变更 → 会话池换代（R-03；调用方同步改名） */
  async invalidateSessions(): Promise<void> {
    await this.p.pool.invalidate()
  }

  // ── 回合（服务行为表）────────────────────────────────────────────────────
  async submit(input: {
    threadId: string
    clientTurnId: string
    text: string
    attachmentIds: readonly string[]
    skills: readonly string[]
    deliverAs: 'turn' | 'steer' | 'followUp'
  }): Promise<{ submission: SubmissionView }> {
    /*
     * 「Core 即时回显」：这里只存库、推送、回复（几毫秒），打开会话与交给 omp 由
     * SubmissionService 在后台做。忙时不再报 thread_busy —— 交接时自动改成排队。
     */ return { submission: this.p.submissions.submit(input) }
  }

  async cancel(threadId: string): Promise<void> {
    /* 还没交给 omp 的 pending 直接收成 failed / submit_cancelled。 */
    this.p.submissions.cancelUnhanded(threadId)
    const session = this.p.pool.peek(threadId)
    if (session === undefined) return
    this.p.router.requestCancel(threadId)
    await session.cancel()
  }

  /** 时间线订阅要画的提交行（线程还没有会话时也要返回）。 */
  submissionsOf(threadId: string, stamped: ReadonlySet<string>): SubmissionView[] {
    return this.p.submissions.viewOfThread(threadId, stamped)
  }

  // ── 时间线（timeline 三段）───────────────────────────────────────────────
  private readonly backfilling = new Set<string>()

  /**
   * 渐进回填：只回填一页装得下的短会话；分页会话留给后台任务，避免拼错顺序。
   * 会话文件读不出来、或已经有别的读者先回填了，都安静退回到文件冷读。
   */
  private async backfillJournal(threadId: string, agentId: string, sessionFile: string): Promise<void> {
    const key = `${threadId}\u0000${agentId}`
    if (this.backfilling.has(key)) return
    this.backfilling.add(key)
    try {
      const first = await this.p.runtime.sessionFiles.readPage(sessionFile, agentId, null)
      const pages = [first]
      let page = first
      /* 往回翻到没有更旧的页；上限 500 页（约 1 万轮），再长就留给后续任务。 */
      while (page.hasMoreOlder === true && pages.length < 500) {
        const oldest = page.items.find((item) => item.kind === 'turn')
        if (oldest === undefined || oldest.kind !== 'turn') break
        page = await this.p.runtime.sessionFiles.readPage(sessionFile, agentId, oldest.turnId)
        pages.push(page)
      }
      if (page.hasMoreOlder === true) return
      const full = pagesToPage(pages)
      if (full === null) return
      if (this.p.journal.latestSeq(threadId, agentId) !== 0) return
      this.p.journal.appendAndStamp(
        threadId,
        agentId,
        eventsFromPage(full, threadId, agentId, new Date(this.d.clock.now()).toISOString()),
      )
    } catch {
      /* 会话文件不可读：保持原有冷读回退，不把一次读变成错误。 */
    } finally {
      this.backfilling.delete(key)
    }
  }

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
   * 只被冷读订阅过的通道打开时也不换代（TimelineService.resetAdvanced）。
   * 还没落过盘的线程没有正文可读：空页，不为一次读去签发会话文件。
   */
  async page(
    threadId: string,
    agentId: string,
    beforeTurnId: string | null,
    throughTurnId: string | null = null,
  ): Promise<TranscriptPage> {
    const options = throughTurnId === null ? undefined : { throughTurnId }
    let page = await this.readPage(threadId, agentId, beforeTurnId, options)
    if (throughTurnId === null) return page
    /*
     * 跳转到很早的一轮：界面只付一次往返。`throughTurnId` 是引擎的可选能力（engine-omp 一次切够，别的实现可以不认），
     * 没覆盖到就在这里接着往前拼 —— 同一进程内的循环，不再是界面那边一页一次 IPC、一页一次整屏重渲。
     */
    let first = firstTurnOf(page)
    while (page.hasMoreOlder === true && first !== undefined && !hasTurn(page, throughTurnId)) {
      const older = await this.readPage(threadId, agentId, first.turnId, options)
      const next = firstTurnOf(older)
      if (next === undefined || next.ordinal >= first.ordinal) {
        throw new AppError(SystemErrorCode.internal, 'Transcript pagination did not advance.')
      }
      page = prependOlder(page, older)
      first = next
    }
    return page
  }

  private async readPage(
    threadId: string,
    agentId: string,
    beforeTurnId: string | null,
    options: { readonly throughTurnId: string } | undefined,
  ): Promise<TranscriptPage> {
    const live = this.p.pool.peek(threadId)
    if (live !== undefined) return await live.page(agentId, beforeTurnId, options)
    const { sessionFile } = this.p.threads.requireRow(threadId)
    if (sessionFile === null) return this.emptyPage()
    /* 冷读优先用 Journal：它已经按 seq 落好 committed 事件，不必再读/重放会话文件。
       头页与旧页都由 Journal 折叠；记录不完整或截断时回退会话文件。 */
    if (agentId === 'main') {
      /* 旧线程第一次冷读：Journal 还没有记录，先把短会话从会话文件回填一次（长会话留给后台任务）。 */
      if (this.p.journal.latestSeq(threadId, agentId) === 0) {
        /* 后台回填：这一次冷读先走会话文件，不让首屏等整个重建。 */
        void this.backfillJournal(threadId, agentId, sessionFile)
      }
      const latest = this.p.journal.latestSeq(threadId, agentId)
      if (latest > 0) {
        const events = this.p.journal.read(threadId, agentId, 0, 100_000)
        /* 只取了前 10 万条时最后一条追不上水位：最近的一轮可能没读到，交给会话文件。 */
        if (events.at(-1)?.seq === latest) {
          const fromJournal = pageFromJournal(events, beforeTurnId)
          if (fromJournal !== null) return fromJournal
        }
      }
    }
    return await this.p.runtime.sessionFiles.readPage(sessionFile, agentId, beforeTurnId, options)
  }

  // ── 队列（queue 三方法）──────────────────────────────────────────────────
  /**
   * 队列快照 —— **读不开会话**（性能方案 P4）。队列只活在活会话的内存里：没开着的会话一定是空队列，
   * 两档模式也是新会话的起点（引擎每条会话都从 all / all 起，不落盘）—— 与「为这一读打开会话再问」逐字相同。
   */
  async queue(threadId: string): Promise<QueueView> {
    const live = this.p.pool.peek(threadId)
    if (live !== undefined) return this.queueViewOf(threadId, live)
    this.p.threads.requireRow(threadId)
    return this.p.submissions.queueViewOf(threadId, IDLE_QUEUE)
  }

  /** 队列只从这里出去：引擎快照挂上提交行的附件，界面才画得出缩略图（见 SubmissionService.queueViewOf） */
  private queueViewOf(threadId: string, session: EngineSession): QueueView {
    return this.p.submissions.queueViewOf(threadId, session.queue())
  }

  async withdraw(threadId: string, itemId: string): Promise<QueueView> {
    /*
     * 队列只存在于活会话里（peek 不 acquire）：为撤回一条排队项去冷启动一条会话没有意义，
     * 冷启动出来的队列一定是空的。没有活会话就是「队列里没有这一项」。
     */
    const session = this.p.pool.peek(threadId)
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
    const session = this.p.pool.peek(threadId)
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
    return (await this.p.pool.peek(threadId)?.cancelSubagent(agentId)) ?? false
  }

  async steerSubagent(threadId: string, agentId: string, text: string): Promise<void> {
    const session = this.p.pool.peek(threadId)
    if (session === undefined) throw new AppError(EngineErrorCode.subagentNotRunning, '这个子代理已经结束了')
    await session.steerSubagent(agentId, text)
  }

  async cancelBackgroundTask(threadId: string, taskId: string): Promise<boolean> {
    return (await this.p.pool.peek(threadId)?.cancelBackgroundTask(taskId)) ?? false
  }

  async setQueueModes(threadId: string, modes: Partial<QueueSnapshot['modes']>): Promise<QueueView> {
    const session = await this.p.pool.acquire(threadId)
    session.setQueueModes(modes)
    return this.queueViewOf(threadId, session)
  }

  // ── 控件（controls 六方法 + 草稿）────────────────────────────────────────
  /**
   * 控件表 —— **读不开会话**（性能方案 P4）。会话开着就问它；没开着：
   * - 还没落过盘（行上没有会话文件）：草稿表，按行上记的初始模型 / 档位 / 姿态 —— 打开时 describe 交给引擎的正是这三格；
   * - 落过盘：控件表快照（会话最后一次报的模型、档位、计划、目标、上下文）配上现读的候选与可用性（controls-snapshot.ts）；
   * - 落过盘却没有快照（快照写入之前的老行、分叉出来的新线程）：照旧打开会话现问 —— 打开时快照写进来，下一次就是冷读。
   * 会话打开时 Core 主动推一次真值（controls.changed），冷读与真值有出入（模型下架被换掉）也只差到那一刻。
   */
  async controls(threadId: string): Promise<Controls> {
    const live = this.p.pool.peek(threadId)
    if (live !== undefined) return live.controls()
    const row = this.p.threads.requireRow(threadId)
    if (row.sessionFile === null) {
      return await this.p.runtime.draftControls({
        model: row.initialModel,
        thinking: row.initialThinking,
        posture: row.posture,
      })
    }
    const snapshot = this.p.repo.controlsSnapshot(threadId)
    if (snapshot === null) return (await this.p.pool.acquire(threadId)).controls()
    const draft = await this.p.runtime.draftControls({
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
    return this.p.runtime.draftControls({
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
        await this.p.runtime.draftControls({
          model: null,
          ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
        })
      ).model.current
    if (model === null) throw new AppError(SystemErrorCode.invalidParams, '没有可用的模型，无法写入默认选择')
    await this.p.runtime.models.setDefaultModel(model, input.thinking)
  }

  async setModel(threadId: string, model: ModelRef): Promise<Controls> {
    const session = await this.p.pool.acquire(threadId)
    await session.setModel(model)
    return session.controls()
  }

  async setThinking(threadId: string, level: string): Promise<Controls> {
    const session = await this.p.pool.acquire(threadId)
    session.setThinking(level)
    return session.controls()
  }

  /** controls.setPosture 同时更新线程行，保证两边一致 */
  async setPostureAction(threadId: string, posture: Posture): Promise<Controls> {
    const session = await this.p.pool.acquire(threadId)
    session.setPosture(posture)
    this.p.threads.setPosture(threadId, posture)
    return session.controls()
  }

  async setPlanMode(threadId: string, enabled: boolean): Promise<Controls> {
    const session = await this.p.pool.acquire(threadId)
    await session.setPlanMode(enabled)
    return session.controls()
  }

  async setGoal(threadId: string, goal: string | null): Promise<Controls> {
    const session = await this.p.pool.acquire(threadId)
    await session.setGoal(goal)
    return session.controls()
  }

  async pauseGoal(threadId: string): Promise<Controls> {
    const session = await this.p.pool.acquire(threadId)
    await session.pauseGoal()
    return session.controls()
  }

  async resumeGoal(threadId: string): Promise<Controls> {
    const session = await this.p.pool.acquire(threadId)
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
    const live = this.p.pool.peek(threadId)
    if (live !== undefined) return await live.commands()
    const row = this.p.threads.requireRow(threadId)
    const cwd = this.p.workspaces.requireUsable(row.workspaceId).path
    return await this.p.runtime.commandCatalog(cwd, { history: row.sessionFile !== null })
  }

  /** 入口页的命令表：不开会话，文件命令按工作区目录读（没给工作区就只有内置命令） */
  async commandCatalog(workspaceId: string | undefined): Promise<readonly SlashCommand[]> {
    const cwd = workspaceId === undefined ? null : this.p.workspaces.requireUsable(workspaceId).path
    return await this.p.runtime.commandCatalog(cwd)
  }

  async runCommand(threadId: string, text: string): Promise<void> {
    const session = await this.p.pool.acquire(threadId)
    await session.runCommand(text)
  }

  // ── 侧边提问（右坞「辅助对话」，omp 的 /btw）────────────────────────────────
  /*
   * 问一句要会话（acquire）：答案拿的就是这条会话的模型、系统提示与历史快照。
   * 进行中由引擎拒绝（engine.side_busy）；问题的空白已在契约层收掉。
   */
  async askSide(threadId: string, question: string, topicId: string | null): Promise<SideTopic> {
    const session = await this.p.pool.acquire(threadId)
    return await session.askSide(question, topicId)
  }

  /** 与 cancelSubagent 同一条理由：正在答的侧边提问只活在活会话里，没有活会话就是「没有在答的」。 */
  cancelSide(threadId: string, topicId: string | null): boolean {
    return this.p.pool.peek(threadId)?.cancelSide(topicId) ?? false
  }

  /**
   * 话题表 —— **读不开会话**（性能方案 P4）。会话开着就问它（正在答的那一问只有它知道）；没开着就冷读会话产物目录里的
   * 话题存档（`SessionFilesPort.sideTopics`，与「重开再问」同一张表）。还没落过盘的线程没有话题可读：空表。
   */
  async sideTopics(threadId: string): Promise<readonly SideTopic[]> {
    const live = this.p.pool.peek(threadId)
    if (live !== undefined) return await live.sideTopics()
    const { sessionFile } = this.p.threads.requireRow(threadId)
    if (sessionFile === null) return []
    return await this.p.runtime.sessionFiles.sideTopics(sessionFile)
  }

  // ── 交互（07 页 §5C 的 interactions 两方法）───────────────────────────────
  interactions(threadId: string): readonly Interaction[] {
    return this.p.pool.peek(threadId)?.interactions() ?? []
  }

  async respond(threadId: string, interactionId: string, answer: InteractionAnswer): Promise<void> {
    const session = this.p.pool.peek(threadId)
    if (session === undefined) {
      throw new AppError(TurnErrorCode.interactionNotFound, '这个请求已经失效')
    }
    session.respond(interactionId, answer)
  }

  // ── 小工具 ────────────────────────────────────────────────────────────────
  stateOf(threadId: string): TurnState['state'] {
    return this.p.pool.peek(threadId)?.state() ?? 'idle'
  }
}

type PageTurn = Extract<TranscriptPage['items'][number], { kind: 'turn' }>

function firstTurnOf(page: TranscriptPage): PageTurn | undefined {
  for (const item of page.items) if (item.kind === 'turn') return item
  return undefined
}

function hasTurn(page: TranscriptPage, turnId: string): boolean {
  return page.items.some((item) => item.kind === 'turn' && item.turnId === turnId)
}

/**
 * Journal 事件 → 时间线的一页。头页取最近一页并生成轮次目录；往前翻页只接受从第 1 轮起完整记录的线程，
 * 否则缺前文，回退会话文件。分页按轮，页大小与引擎历史投影一致。
 */
type JournalTurn = Extract<TranscriptPage['items'][number], { kind: 'turn' }>

export function pageFromJournal(
  events: readonly import('@poietica/agent-model').AgentEvent[],
  beforeTurnId: string | null,
  pageSize = 20,
): TranscriptPage | null {
  if (events.length === 0) return null
  const snapshot = snapshotOf(reduceAll(EMPTY_THREAD_STATE, events))
  const turns = snapshot.items.filter((item): item is JournalTurn => item.kind === 'turn')
  const window = journalWindow(turns, beforeTurnId, pageSize)
  if (window === null) return null
  if (window.turns.length === 0) return { ...snapshot, items: [], hasMoreOlder: false }
  const head = window.turns[0]!
  const tail = window.turns.at(-1)!
  const start = snapshot.items.findIndex((item) => item.kind === 'turn' && item.turnId === head.turnId)
  const end = snapshot.items.findIndex((item) => item.kind === 'turn' && item.turnId === tail.turnId)
  if (start < 0 || end < start) return null
  return {
    ...snapshot,
    items: snapshot.items.slice(start, beforeTurnId === null ? undefined : end + 1),
    hasMoreOlder: window.hasMoreOlder,
    ...(beforeTurnId === null ? { outline: outlineOfTurns(turns) } : {}),
  }
}

function journalWindow(
  turns: readonly JournalTurn[],
  beforeTurnId: string | null,
  pageSize: number,
): { turns: readonly JournalTurn[]; hasMoreOlder: boolean } | null {
  const first = turns[0]
  const last = turns.at(-1)
  if (first === undefined || last === undefined) return null
  /* 往前翻的页必须从第 1 轮起完整记录；头页可以只覆盖最近的记录（前文交给文件）。 */
  if (beforeTurnId !== null && first.ordinal !== 1) return null
  /* Journal 还没覆盖到这一页（截断或这一轮比最后一条事件新）：交给会话文件。 */
  if (beforeTurnId !== null && turnOrdinal(beforeTurnId) > last.ordinal + 1) return null
  const older = beforeTurnId === null ? turns : turns.filter((turn) => turn.ordinal < turnOrdinal(beforeTurnId))
  const window = older.slice(Math.max(0, older.length - pageSize))
  const hasMoreOlder =
    beforeTurnId === null ? turns.length > window.length || first.ordinal > 1 : older.length > window.length
  return { turns: window, hasMoreOlder }
}

const OUTLINE_PROMPT_CHARS = 200
const OUTLINE_REPLY_CHARS = 280

function outlineOfTurns(turns: readonly JournalTurn[]): NonNullable<TranscriptPage['outline']> {
  return turns
    .filter((turn) => turn.origin.kind === 'user')
    .map((turn) => {
      const reply = turn.steps
        .flatMap((step) => step.frames)
        .map((frame) => (frame.kind === 'text' && frame.role === 'assistant' ? frame.text : ''))
        .filter((text) => text !== '')
        .at(-1)
      return {
        turnId: turn.turnId,
        ordinal: turn.ordinal,
        prompt: clip(turn.prompt ?? '', OUTLINE_PROMPT_CHARS),
        ...(reply === undefined ? {} : { reply: clip(reply, OUTLINE_REPLY_CHARS) }),
      }
    })
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed
}
