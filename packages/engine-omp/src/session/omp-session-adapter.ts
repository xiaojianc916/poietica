import type { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import { buildSkillPromptMessage } from '@oh-my-pi/pi-coding-agent/extensibility/skills'
import type { LocalProtocolOptions } from '@oh-my-pi/pi-coding-agent/internal-urls/local-protocol'
import { RpcBtwController } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-btw'
import type { RpcGoalSession } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal'
import { computeSessionContextBreakdown } from '@oh-my-pi/pi-coding-agent/session/context-usage-runtime'
import {
  TASK_SUBAGENT_LIFECYCLE_CHANNEL,
  TASK_SUBAGENT_PROGRESS_CHANNEL,
} from '@oh-my-pi/pi-tui/overlays/session-observer-registry'
import {
  type ContextUsage,
  EngineErrorCode,
  type EngineSession,
  type EngineToolSpec,
  type OpenSessionSpec,
  type SessionGoalSnapshot,
  type SubmitInput,
} from '@poietica/engine'
import { AppError, type Logger, SystemErrorCode, systemClock } from '@poietica/foundation'
import { InteractionBroker } from '../interactions/broker'
import { planInteraction, planOutcomeOf } from '../interactions/plan'
import { createUiContext } from '../interactions/ui-context'
import { BackgroundJobLedger, jobIdOf } from '../projector/background-jobs'
import { compactionEndPayload, latestCompactionOf } from '../projector/compaction'
import { lastTurnOrdinal, type OmpMessage, projectHistoryPage } from '../projector/history'
import { LiveProjector } from '../projector/live'
import type { MediaRef } from '../projector/media'
import { retryEndOf, retryStartOf } from '../projector/retry'
import { SubagentLedger } from '../projector/subagents'
import { TodoMirror } from '../projector/todos'
import type { SettingsScope } from '../settings-access'
import { type OmpUsageStatisticsLike, toContextUsage } from './context-usage'
import { describeError, EventFaults } from './event-faults'
import { createGoalHost, type GoalHost } from './goal-host'
import type { GoalCapableSession, PlanArtifactSession, PlanCapableSession } from './plan-goal'
import {
  applyGoal,
  applyPlanMode,
  availabilityOf,
  DEFAULT_PLAN_FILE,
  pauseGoalMode,
  resumeGoalMode,
  settlePlanProposal,
} from './plan-goal'
import { applyPosture, grantToolForSession } from './posture'
import {
  expandSkillMessage,
  imageContentsOf,
  isGoalContinuationMessage,
  isUserSkillMessage,
  type LoadedImage,
  loadImages,
  preparePrompt,
  queueChipOf,
  type SkillPromptMessage,
} from './prompt'
import { OmpSession } from './session'
import { SideQuestions } from './side-questions'
import { listSlashCommands, resolveSlashCommand, runBuiltinCommand } from './slash-commands'
import { userTextOf } from './subagent-channels'
import { createSubagentHost, type SubagentHost } from './subagent-host'

type BreakdownSession = Parameters<typeof computeSessionContextBreakdown>[0]

/** omp 的 AgentSession 面上我们真正用到的那几格（按结构收窄，不绑 omp 深层类型） */
interface OmpAgentSessionLike {
  readonly sessionId: string
  readonly sessionFile: string | undefined
  /* 控件表要报「这条会话实际会用哪一条」，所以初值不能只看 spec，SDK 自己挑的那一条也要读得回来 */
  readonly model?: { readonly provider: string; readonly id: string } | undefined
  readonly thinkingLevel?: string | undefined
  readonly settings: SettingsScope
  /** 模型上下文：压缩之后只剩「摘要 + 保留的尾巴」，不能拿来画屏幕（见 transcriptOf） */
  readonly messages: readonly OmpMessage[]
  /**
   * omp 的显示经过（TUI 重画对话用的同一个入口）。collapseCompactedHistory:false = 压缩不抹掉前文，
   * 每次压缩在它发生的位置留一条 compactionSummary。
   */
  buildTranscriptSessionContext?(options?: {
    readonly collapseCompactedHistory?: boolean
    readonly keepDanglingToolCalls?: boolean
  }): { readonly messages: readonly OmpMessage[] }
  /**
   * **不要在 AgentSession 上直接读 artifactsDir / cwd** —— 真实形状里只有 sessionManager：读出来恒是
   * undefined，`local://` 会退到 `os.tmpdir()`，artifacts 里的计划一份也解不出来。
   */
  readonly sessionManager: {
    getArtifactsDir(): string | null
    getSessionId(): string
    getCwd(): string
    getSessionName?(): string | undefined
    onSessionNameChanged?(cb: () => void): () => void
    /** omp 的会话名来源（会话头 titleSource）：user = 用户定名，之后自动总结不再覆盖 */
    readonly titleSource?: 'auto' | 'user' | undefined
    setSessionName?(name: string, source: 'auto' | 'user'): Promise<boolean>
    /** omp 的会话用量累计（/usage、ACP usage_update 读的同一份）；形状由 context-usage.ts 收窄 */
    getUsageStatistics?(): OmpUsageStatisticsLike
  }
  readonly skills: readonly {
    readonly name: string
    readonly filePath?: string
    readonly baseDir?: string
  }[]
  subscribe(listener: (event: Record<string, unknown>) => void): () => void
  prompt(text: string, options?: Record<string, unknown>): Promise<boolean>
  promptCustomMessage(message: Record<string, unknown>, options?: Record<string, unknown>): Promise<boolean>
  steer(text: string, images?: readonly unknown[], options?: Record<string, unknown>): Promise<void>
  followUp(text: string, images?: readonly unknown[], options?: Record<string, unknown>): Promise<void>
  abort(options?: Record<string, unknown>): Promise<void>
  dispose(options?: Record<string, unknown>): Promise<void>
  setPromptDropped(handler: ((prompt: { readonly text: string }) => void) | undefined): void
  setThinkingLevel(level: unknown, persist?: boolean): void
  setSteeringMode(mode: 'all' | 'one-at-a-time', persist?: boolean): void
  setFollowUpMode(mode: 'all' | 'one-at-a-time', persist?: boolean): void
  getQueuedMessages(): { readonly steering: readonly string[]; readonly followUp: readonly string[] }
  removeQueuedMessage(text: string, queue: 'steering' | 'followUp'): boolean
  /**
   * 字段名是 omp 的 `{ tokens, contextWindow, percent }`，**不是** `{ usedTokens, windowTokens }`：按后者读会被
   * 判成「会话还没报过」，输入框那颗上下文圆环永远不画（真机故障）。
   */
  getContextUsage(): { readonly tokens?: number; readonly contextWindow?: number } | undefined
  getAvailableThinkingLevels?(): readonly string[]
  getAvailableModels?(): readonly {
    readonly provider: string
    readonly id: string
    readonly name?: string
    readonly reasoning?: boolean
    readonly input?: readonly string[]
  }[]
  setModel?(model: unknown, role?: string, options?: { readonly persist?: boolean }): Promise<unknown>
  getLastAssistantMessage(): { readonly stopReason?: string; readonly errorMessage?: string } | undefined
  getEnabledToolNames?(): string[]
  hasBuiltInTool?(name: string): boolean
  setActiveToolsByName?(toolNames: string[]): Promise<void>
  getPlanModeState?(): { enabled: boolean; planFilePath: string; workflow?: string } | undefined
  setPlanModeState?(
    state: { enabled: boolean; planFilePath: string; workflow?: string; reentry?: boolean } | undefined,
  ): void
  setPlanProposalHandler?(handler: ((title: string) => Promise<unknown>) | null): void
  setPlanReferencePath?(path: string): void
  getGoalModeState?(): { goal: { objective?: string; status?: string } } | undefined
  setGoalModeState?(state: unknown): void
  readonly goalRuntime?: {
    createGoal(input: { objective: string }): Promise<unknown>
    replaceGoal(input: { objective: string }): Promise<unknown>
    resumeGoal(): Promise<unknown>
    pauseGoal(): Promise<unknown>
    dropGoal(): Promise<unknown>
  }
  readonly isStreaming?: boolean
  /* 命令表变化（插件装卸、技能 / 命令目录重扫、MCP 提示词上线）；RPC / ACP 宿主靠它重发命令表 */
  subscribeCommandMetadataChanged?(listener: () => void): () => void
  sendPlanModeContext?(options?: { deliverAs?: 'steer' | 'followUp' | 'nextTurn' | 'aside' }): Promise<void>
  sendGoalModeContext?(options?: { deliverAs?: 'steer' | 'followUp' | 'nextTurn' | 'aside' }): Promise<void>
  /** omp 的待办表（todo 工具维护的 TodoPhase[]）；形状由 projector/todos.ts 收窄 */
  getTodoPhases?(): unknown
  /** omp 的后台作业表（状态栏、/jobs 读的同一份）；作业管理器没开时是 null */
  getAsyncJobSnapshot?(options?: { readonly recentLimit?: number }): unknown
  cancelAsyncJob?(id: string): boolean
}

/** 有后台作业跑着时多久对一次账：omp 不为作业变化发事件，只能读快照（与它状态栏的刷新同一个量级） */
const JOB_POLL_MS = 1000
/** 快照里带几条已结作业：取大一点，刚结束的作业不至于在两次对账之间被挤出去、被误标成 lost */
const JOB_RECENT_LIMIT = 50

export interface WrapOmpSessionInput {
  readonly spec: OpenSessionSpec
  readonly settings: SettingsScope
  readonly agentSession: unknown
  readonly setToolUIContext: (ui: unknown, hasUI: boolean) => void
  readonly mcpManager: unknown
  readonly tools: ReadonlyMap<string, EngineToolSpec>
  readonly logger: Logger
  readonly subagentBus: { on(channel: string, listener: (data: unknown) => void): () => void } | null
  readonly initializeExtensions: (session: unknown, ui: unknown) => Promise<void>
  readonly model: { provider: string; id: string } | null
  readonly thinking: string | null
  /* 按 ref 查模型目录（静态）：会话还没水合时，控件初值也要答得出来；查不到就交 null，不编一条 */
  readonly modelCatalog: (ref: { readonly provider: string; readonly id: string }) => {
    readonly label: string
    readonly efforts: readonly string[]
    readonly defaultLevel: string | null
  } | null
  readonly loadImageFiles?: (
    images: readonly { readonly path: string; readonly mime: string }[],
  ) => Promise<readonly LoadedImage[]>
  /** 用户图片 → 时间线地址。生产是 `blobMediaRef(layout.ompBlobsDir)`；必填 —— 漏传等于发出 Host 读不到字节的地址 */
  readonly mediaRef: MediaRef
}

export async function wrapOmpSession(input: WrapOmpSessionInput): Promise<EngineSession> {
  const session = input.agentSession as OmpAgentSessionLike
  const broker = new InteractionBroker(
    () => systemClock.now(),
    (error) =>
      input.logger.error('interaction listener threw', {
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
      }),
  )
  const projector = new LiveProjector({ now: () => systemClock.now() })
  const sessionKey = input.spec.key
  const ledger = new SubagentLedger({ now: () => systemClock.now() })
  const todos = new TodoMirror(() => systemClock.now())
  const jobs = new BackgroundJobLedger()
  /* 子代理通道要往 ompSession 上发，而 ompSession 要用它答 page / 停止 / 引导：同 planner 一样先声明、后接上 */
  let subagents: SubagentHost | null = null
  /*
   * omp 知识 #19：屏幕上的经过 = omp 的**显示经过**（压缩只在原处留一格摘要，前文都在），不是 `session.messages`：
   * 那是模型上下文，压缩之后只剩「摘要 + 保留的尾巴」（审查 R-21-1）。分页与落座必须读同一份，
   * 否则落座的号比屏幕上的少，下一句话会盖掉已有的轮。
   * 开着一轮时让 omp 保留悬挂调用：正在跑的那次工具调用还没有结果，剥掉它屏幕上那一行就没了；
   * 封了口的轮里的悬挂调用由历史投影自己剥（与 omp 同一个口径）。
   * 形状里没有这个方法（测试替身）才退回模型上下文。
   */
  const transcriptOf = (): readonly OmpMessage[] =>
    session.buildTranscriptSessionContext === undefined
      ? session.messages
      : session.buildTranscriptSessionContext({
          collapseCompactedHistory: false,
          keepDanglingToolCalls: projector.isTurnOpen,
        }).messages
  // 重开会话：累加器要摆到屏幕上已有的位置，否则第一句话会盖掉已有的轮
  projector.seat(lastTurnOrdinal(transcriptOf()))
  /*
   * 上下文用量：读数取 getContextUsage，构成取 omp 自己的 computeSessionContextBreakdown（/context 面板印的
   * 就是这一份；自己折那五格会与屏幕上显示的对不上），会话用量取 sessionManager.getUsageStatistics()
   * （/usage 与 ACP usage_update 那一份）。每次现读、不存第二份；算不出构成只是没有明细，读不到用量只是不画那两行。
   */
  const readContextUsage = (): ContextUsage | null => {
    let breakdown: Parameters<typeof toContextUsage>[1]
    try {
      breakdown = computeSessionContextBreakdown(session as unknown as BreakdownSession)
    } catch (cause) {
      input.logger.warn('context breakdown failed', { error: String(cause) })
    }
    let stats: OmpUsageStatisticsLike | undefined
    try {
      stats = session.sessionManager.getUsageStatistics?.()
    } catch (cause) {
      input.logger.warn('session usage statistics failed', { error: String(cause) })
    }
    return toContextUsage(session.getContextUsage(), breakdown, stats)
  }

  const ui = createUiContext(broker, { grantTool: (tool) => grantToolForSession(input.settings, tool) })
  /* 计划模式控制器：持「进模式前那份工具集」，装 omp 要的 PlanProposalHandler 把 `xd://propose` 问成卡片 */
  const planner = createPlanner({
    session,
    broker,
    root: input.settings,
    logger: input.logger,
    /* 这个箭头定义时先引用、调用时再求值 —— planner 与 ompSession 互相需要，只能这样接上 */
    emitControls: () => ompSession.controlsChanged(),
  })
  const goal = createGoalHost({
    session: input.agentSession as RpcGoalSession,
    logger: input.logger,
    hooks: {
      reserveContinuation: () => ompSession.reserveGoalContinuation(),
      releaseContinuation: (error) => ompSession.releaseGoalContinuation(error),
      continuationDropped: () => ompSession.goalContinuationDropped(),
    },
  })
  /*
   * 侧边提问（omp 知识 #21）：控制器只在开问时才碰会话（model / runEphemeralTurn / sessionManager），所以测试里的
   * 结构替身也能照常建它。真身形状由 omp 的类型说了算，这里与 goal 那一条一样直接交 agentSession。
   */
  const side = new SideQuestions({
    createController: (output) =>
      new RpcBtwController(input.agentSession as ConstructorParameters<typeof RpcBtwController>[0], output),
    hasModel: () => session.model !== undefined && session.model !== null,
    /* 与 planner 一样：箭头调用时才求值 ompSession */
    emit: (event) => ompSession.emitSide(event),
    logger: input.logger,
  })
  const ompSession = new OmpSession(
    {
      spec: input.spec,
      side,
      logger: input.logger,
      broker,
      projector,
      /* 图片在 runTurn 里异步读一次，结果既画时间线又交给 prompt，两处共用同一份 base64 */
      loadImages: async (images) => await (input.loadImageFiles ?? loadImages)(images),
      mediaRef: input.mediaRef,
      promptWithImages: async (submit, images, skillMessage) =>
        await deliverPrompt(session, submit, skillMessage, images),
      /*
       * `text` 是**投递正文**（用户原文 + 每个文件一行 `@<绝对路径>`）。不能发 `submit.text`：文件在排队 /
       * 插话这条路上会被静默丢掉，而队列对账、removeQueuedMessage、message_start 认领都认这一份。
       */
      steer: async (submit, deliverAs, skillMessage, images) => {
        const prepared = preparePrompt(submit, images === undefined ? {} : { loadedImages: images })
        if (skillMessage !== null) {
          await session.promptCustomMessage(skillMessage as unknown as Record<string, unknown>, {
            streamingBehavior: deliverAs,
            /*
             * omp 的队列 chip 与 removeQueuedMessage 都认 `queueChipText`（它被写进 details.__queueChipText），
             * 所以技能分支的 wireText 就是用户原文 —— 对账与撤回两边同一份字符串。
             */
            queueChipText: submit.text,
          })
          return { wireText: submit.text, chipText: submit.text }
        }
        if (deliverAs === 'steer') await session.steer(prepared.text, [...prepared.imageContents])
        else await session.followUp(prepared.text, [...prepared.imageContents])
        return { wireText: prepared.text, chipText: queueChipOf(prepared.text, prepared.imageContents.length) }
      },
      abort: async () => await session.abort(),
      disposeSession: async () => await session.dispose(),
      queueOf: () => session.getQueuedMessages(),
      removeQueued: (wireText, deliverAs) =>
        session.removeQueuedMessage(wireText, deliverAs === 'steer' ? 'steering' : 'followUp'),
      setQueueMode: (kind, value) => {
        // persist 一律 false：只影响本会话
        if (kind === 'steer') session.setSteeringMode(value, false)
        else session.setFollowUpMode(value, false)
      },
      setApprovalMode: (posture) => applyPosture(input.settings, posture),
      grantTool: (tool) => grantToolForSession(input.settings, tool),
      /* 控件表读的是**会话此刻的真相**：omp 的 model_changed 只会叫我们重发一次表，读数必须现读现报 */
      liveModel: () => {
        const current = session.model
        return current === undefined ? null : { provider: current.provider, id: current.id }
      },
      liveThinking: () => session.thinkingLevel ?? null,
      lastAssistant: () => session.getLastAssistantMessage(),
      thinkingChoices: () => thinkingLevelsOf(session),
      modelChoices: () => modelsOf(session),
      modelLabel: (model) => input.modelCatalog(model)?.label ?? `${model.provider}/${model.id}`,
      /* 会话没水合时用这条模型静态的梯子兜底（模型目录里烤好的 efforts）；查不到就空表 */
      thinkingFallback: (model) => (model === null ? [] : (input.modelCatalog(model)?.efforts ?? [])),
      defaultThinking: (model) => (model === null ? null : (input.modelCatalog(model)?.defaultLevel ?? null)),
      setModelOnSession: async (model) => {
        /* omp 的 setModel 收的是 Model 实例，不是 ref；找不到（不在白名单、下架）时如实抛，不静默换别的 */
        const target = (session.getAvailableModels?.() ?? []).find(
          (entry) => entry.provider === model.provider && entry.id === model.id,
        )
        if (target === undefined) {
          throw new AppError(EngineErrorCode.modelNotFound, `找不到所选模型：${model.provider}/${model.id}`)
        }
        if (session.setModel === undefined) {
          throw new AppError(SystemErrorCode.internal, '这条会话不支持切换模型')
        }
        // persist:false —— 只影响本会话，不改全局默认
        await session.setModel(target, undefined, { persist: false })
      },
      setThinkingOnSession: (level) => session.setThinkingLevel(level, false),
      /* 每次现读、不存第二份（存一份会与上面「控件表读会话真相」那条打架） */
      contextUsage: readContextUsage,
      skillMessage: async (submit, images) => {
        /* turn 那条路把已读好的图传进来，这里就不再读第二遍 */
        const imageContents = images === undefined ? preparePrompt(submit, {}).imageContents : imageContentsOf(images)
        return await expandSkillMessage(submit, imageContents, {
          availableSkills: session.skills.map((skill) => skill.name),
          skillMessage: (name, args) => skillPromptOf(session, name, args),
        })
      },
      applyPlanMode: (enabled) => planner.setPlanMode(enabled),
      applyGoal: async (objective) => {
        await applyGoal({ session: goalSessionOf(session), host: goal, root: input.settings, goal: objective })
      },
      pauseGoal: async () => {
        await pauseGoalMode({ session: goalSessionOf(session), host: goal })
      },
      resumeGoal: async () => {
        await resumeGoalMode({ session: goalSessionOf(session), host: goal, root: input.settings })
      },
      goalContinuationPending: () => goal.continuationPending(),
      stopGoalContinuation: () => goal.stopForHostAbort(),
      planAvailable: () => availabilityOf(input.settings).plan,
      goalAvailable: () => availabilityOf(input.settings).goal,
      livePlanMode: () => planner.isPlanModeOn(),
      liveGoal: () => goalOf(session),
      liveGoalSnapshot: () => goalSnapshotOf(session),
      page: async (agentId, beforeTurnId, { openTurnShown, throughTurnId }) => {
        if (agentId !== 'main') {
          return subagents === null ? projectHistoryPage([], null) : await subagents.page(agentId, beforeTurnId)
        }
        const page = projectHistoryPage(transcriptOf(), beforeTurnId, {
          ...(throughTurnId === undefined ? {} : { throughTurnId }),
          isTurnOpen: projector.isTurnOpen && !openTurnShown,
          openTurnAttachments: projector.openTurnAttachments,
          mediaRef: input.mediaRef,
        })
        /*
         * 子代理行、后台作业、待办只活在增量那条路上：整页不带它们，重订阅（切走再切回、Core 重启、补缺口）
         * 之后状态弹窗里这几节就整片消失，要等下一帧增量才回来。它们是会话级的、不分页 —— 每一页都带同一份。
         */
        const current = todos.current
        return {
          ...page,
          tasks: [...ledger.tasks, ...jobs.tasks],
          todos: current === null ? [] : [current],
        }
      },
      cancelSubagent: async (agentId) => (subagents === null ? false : await subagents.cancel(agentId)),
      steerSubagent: async (agentId, text) => {
        if (subagents === null) throw new AppError(EngineErrorCode.subagentNotRunning, '这个子代理已经结束了')
        await subagents.steer(agentId, text)
      },
      cancelBackgroundTask: async (taskId) => {
        const jobId = jobIdOf(taskId)
        if (jobId === null || session.cancelAsyncJob === undefined) return false
        const cancelled = session.cancelAsyncJob(jobId)
        /* 立刻对一次账：面板上的「停止」要马上变成「已停止」，不等下一次轮询 */
        refreshJobs()
        return cancelled
      },
      now: () => systemClock.now(),
      commands: async () => await listSlashCommands(session),
      resolveCommand: async (text) => await resolveSlashCommand(session, text),
      setSessionName: async (name) => (await session.sessionManager?.setSessionName?.(name, 'user')) ?? false,
      runBuiltinCommand: async (text, hooks) => await runBuiltinCommand(session, text, hooks),
      reseat: () => projector.seat(lastTurnOrdinal(transcriptOf())),
    },
    { sessionId: session.sessionId, sessionFile: session.sessionFile ?? '' },
  )
  void agentIdNote(sessionKey)
  // omp 知识 #8：必须接上 setPromptDropped —— 不接的话 omp 丢弃用户输入（例如压缩期间）时消息会凭空消失
  session.setPromptDropped((prompt) => ompSession.emitPromptDropped(prompt.text))
  /* `faults` 是事件泵的要害：分流不能包在吞掉一切的 catch 里，异常被咽下就既不记日志、也不上屏 */
  const pump: EventPump = {
    session: ompSession,
    projector,
    goal,
    faults: new EventFaults(input.logger, () => projector.turnOrdinal),
    latestCompaction: () => latestCompactionOf(transcriptOf()),
    logger: input.logger,
    streamsInput: (toolName) => input.tools.get(toolName)?.streamInput === true,
    afterEvent: (type) => {
      /*
       * 待办与后台作业都没有自己的增量事件：todo 工具在 execute 里直接改 omp 的 phases，后台作业在
       * AsyncJobManager 里跑。所以在「可能改过它们」的那几个点现读一次真身、去重后再发。
       */
      if (type === 'tool_execution_end' || type === 'todo_auto_clear' || type === 'agent_end') syncTodos()
      if (type === 'tool_execution_end' || type === 'message_end' || type === 'agent_end') refreshJobs()
    },
  }
  let closed = false
  const syncTodos = (): void => {
    if (closed || session.getTodoPhases === undefined) return
    try {
      ompSession.requestTimeline(todos.sync(session.getTodoPhases()))
    } catch (error) {
      input.logger.warn('todo sync failed', { error: describeError(error) })
    }
  }
  let jobTimer: ReturnType<typeof setTimeout> | null = null
  const refreshJobs = (): void => {
    if (closed || session.getAsyncJobSnapshot === undefined) return
    try {
      const snapshot = session.getAsyncJobSnapshot({ recentLimit: JOB_RECENT_LIMIT })
      /* null = 作业管理器没开：没有快照不等于作业都没了，不对账（否则会把跑着的全标成 lost） */
      if (snapshot !== null && snapshot !== undefined) ompSession.requestTimeline(jobs.reconcile(snapshot))
    } catch (error) {
      input.logger.warn('background job sync failed', { error: describeError(error) })
    }
    if (jobTimer === null && jobs.hasRunning && !closed) {
      const timer = setTimeout(() => {
        jobTimer = null
        refreshJobs()
      }, JOB_POLL_MS)
      /* 轮询不该吊住进程退出 */
      timer.unref?.()
      jobTimer = timer
    }
  }
  const subscriptions = [
    toSub(() => {
      closed = true
      if (jobTimer !== null) clearTimeout(jobTimer)
      jobTimer = null
    }),
    ompSession.attachBroker(),
    /* omp 知识 #17：回调**不带名字**（要自己读 getSessionName），订阅**没有回放** */
    toSub(
      session.sessionManager?.onSessionNameChanged?.(() => {
        const name = session.sessionManager?.getSessionName?.()
        if (typeof name === 'string' && name !== '') ompSession.emitSessionTitle(name, titleSourceOf(session))
      }) ?? (() => undefined),
    ),
    // omp 的 subscribe 直接返回退订函数：包一层再存，dispose 时真的退订
    toSub(session.subscribe((event) => handleOmpEvent(event, pump))),
    toSub(session.subscribeCommandMetadataChanged?.(() => ompSession.commandsChanged()) ?? (() => undefined)),
  ]
  if (input.subagentBus !== null) {
    subscriptions.push(
      toSub(
        input.subagentBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, (data) => {
          ompSession.requestTimeline(ledger.lifecycle(data))
        }),
      ),
    )
    subscriptions.push(
      toSub(
        input.subagentBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, (data) => {
          ompSession.requestTimeline(ledger.progress(data))
        }),
      ),
    )
    const host = createSubagentHost({
      bus: input.subagentBus,
      now: () => systemClock.now(),
      logger: input.logger,
      emit: (agentId, ops) => ompSession.emitAgentTimeline(agentId, ops),
      artifactsDir: () => session.sessionManager?.getArtifactsDir() ?? null,
    })
    subagents = host
    subscriptions.push({
      dispose: () => {
        subagents = null
        host.dispose()
      },
    })
  }
  ompSession.attach(subscriptions)
  // omp 知识 #6：hasUI + setToolUIContext + initializeExtensions 三者缺一不可
  input.setToolUIContext(ui, true)
  await input.initializeExtensions(session, ui)
  /*
   * 把会话文件里记着的目标接回来，必须在订阅接上之后（接回时 omp 会发 goal_updated）。进行中的目标
   * 一律以「已暂停」接回 —— 刚打开的会话没有任何东西在推进它。
   */
  await goal.reconcile()
  /*
   * 控件初值：**解析不出模型时不写**。写一个空 ref 会让 `controls.get` 每次都被 zod 退回，
   * 输入框上沿挂出「没连上 agent，点击重试」（真机实测）。
   */
  if (input.model !== null) await ompSession.setModel(input.model)
  if (input.thinking !== null) ompSession.setThinking(input.thinking)
  /* 打开一条已经有名字的会话：补报一次 —— onSessionNameChanged 没有回放，而会话池在返回值之后才订阅 */
  const seededName = session.sessionManager?.getSessionName?.()
  if (typeof seededName === 'string' && seededName !== '')
    ompSession.emitSessionTitle(seededName, titleSourceOf(session))
  /* 打开一条已有待办 / 作业的会话：先对一次账，弹窗不必等到下一次工具调用才出现 */
  syncTodos()
  refreshJobs()
  return ompSession
}

/** omp 记的会话名来源；读不到按 auto（omp setSessionName 的默认来源） */
function titleSourceOf(session: OmpAgentSessionLike): 'auto' | 'user' {
  return session.sessionManager?.titleSource === 'user' ? 'user' : 'auto'
}

function thinkingLevelsOf(session: OmpAgentSessionLike): readonly string[] {
  try {
    return session.getAvailableThinkingLevels?.() ?? []
  } catch {
    return []
  }
}

/** label 用模型自己的名字，取不到才退回 id：真实故障里输入框显示的是 `deepseek/deepseek-v4-pro` */
function modelsOf(session: OmpAgentSessionLike): readonly {
  readonly ref: { readonly provider: string; readonly id: string }
  readonly label: string
  readonly reasoning: boolean
  readonly images: boolean
}[] {
  try {
    return (session.getAvailableModels?.() ?? []).map((model) => ({
      ref: { provider: model.provider, id: model.id },
      label: model.name ?? model.id,
      reasoning: model.reasoning === true,
      images: model.input?.includes('image') === true,
    }))
  } catch {
    return []
  }
}

function toSub(unsubscribe: () => void): { dispose(): void } {
  return { dispose: unsubscribe }
}

/* `message_start` 的消息身份只看 role：它是唯一在流式增量之前就到了的一格 */
function startedRoleOf(raw: unknown): unknown {
  const message = raw as { readonly role?: unknown } | undefined
  return message?.role
}

/* user 消息按投递正文认领；技能消息走 promptCustomMessage，omp 发的是 custom 消息，要类型 + 归属两格都对 */
function claimStartedMessage(raw: unknown, session: OmpSession): void {
  const message = raw as
    | {
        readonly role?: string
        readonly content?: unknown
        readonly customType?: unknown
        readonly attribution?: unknown
      }
    | undefined
  if (message === undefined) return
  if (message.role === 'user') {
    /*
     * 空正文也要认领：只带图的那一句（本轮自己的纯图 prompt、纯图插话）正文就是 ''。以前这里跳过空正文，
     * 纯图插话永远画不上屏（重开后历史投影却画得出来），纯图 prompt 的 ownPrompt 也一直不清，会吞掉下一条纯图插话。
     * 账本里只有纯图项的投递正文是 ''，不会认错别的项。
     */
    session.onUserMessageStart(userTextOf(message.content))
    return
  }
  if (isUserSkillMessage(message)) session.onSkillMessageStart()
  // 目标续跑那一轮真的开跑了：时间线在这里开一轮
  else if (isGoalContinuationMessage(message)) session.startGoalContinuationTurn()
}

/** 计划那几格缺失时**如实报错**而不是静默跳过 —— 静默跳过会让「进计划模式」看起来成功了 */
function planSessionOf(session: OmpAgentSessionLike): PlanCapableSession {
  const missing: () => never = () => {
    throw new AppError(SystemErrorCode.internal, '这条会话不支持计划模式')
  }
  return {
    getEnabledToolNames: () => session.getEnabledToolNames?.() ?? missing(),
    hasBuiltInTool: (name) => session.hasBuiltInTool?.(name) ?? missing(),
    /*
     * 判空时**别把方法从会话上摘下来**：omp 的 setActiveToolsByName 是类方法，内部读 `this.#tools`，
     * 摘下来再裸调会丢 this —— 真机缺陷：目标模式一设就报 `undefined is not an object`。
     */
    setActiveToolsByName: async (names) => {
      if (session.setActiveToolsByName === undefined) missing()
      await session.setActiveToolsByName(names)
    },
    getPlanModeState: () => session.getPlanModeState?.(),
    setPlanModeState: (state) => (session.setPlanModeState as ((s: unknown) => void) | undefined)?.(state),
    setPlanProposalHandler: (handler) => session.setPlanProposalHandler?.(handler),
    setPlanReferencePath: (path) => session.setPlanReferencePath?.(path),
    get isStreaming(): boolean {
      return session.isStreaming === true
    },
    sendPlanModeContext: async (options) => await session.sendPlanModeContext?.(options),
  }
}

function goalSessionOf(session: OmpAgentSessionLike): GoalCapableSession {
  const missing: () => never = () => {
    throw new AppError(SystemErrorCode.internal, '这条会话不支持目标模式')
  }
  return {
    hasBuiltInTool: (name) => session.hasBuiltInTool?.(name) ?? missing(),
    getPlanModeState: () => session.getPlanModeState?.(),
    getGoalModeState: () =>
      session.getGoalModeState?.() as GoalCapableSession['getGoalModeState'] extends () => infer R ? R : never,
    setGoalModeState: (state) => session.setGoalModeState?.(state),
    goalRuntime: session.goalRuntime ?? (missing() as never),
    get isStreaming(): boolean {
      return session.isStreaming === true
    },
    sendGoalModeContext: async (options) => await session.sendGoalModeContext?.(options),
  }
}

/**
 * 会话此刻的目标快照；dropped 按「没有目标」报，`budget-limited` → `blocked`（产品词表只有四档）。
 * `completionCriterion` / `turnsUsed` 在 omp 里没有对应字段，恒报 null / 0，不编假值。
 */
function goalSnapshotOf(session: OmpAgentSessionLike): SessionGoalSnapshot | null {
  const goal = session.getGoalModeState?.()?.goal
  if (goal === undefined || goal.status === undefined || goal.status === 'dropped') return null
  if (typeof goal.objective !== 'string') return null
  const raw = goal as {
    readonly status: string
    readonly tokensUsed?: unknown
    readonly timeUsedSeconds?: unknown
  }
  const status: SessionGoalSnapshot['status'] =
    raw.status === 'budget-limited' ? 'blocked' : (raw.status as SessionGoalSnapshot['status'])
  return {
    objective: goal.objective,
    completionCriterion: null,
    status,
    turnsUsed: 0,
    tokensUsed: typeof raw.tokensUsed === 'number' ? raw.tokensUsed : 0,
    wallClockMs: typeof raw.timeUsedSeconds === 'number' ? raw.timeUsedSeconds * 1000 : 0,
  }
}

/** dropped 与 complete 都按「没有目标」报（驱动输入框那颗开关）；完成那一档的面板仍报 complete */
function goalOf(session: OmpAgentSessionLike): string | null {
  const snapshot = goalSnapshotOf(session)
  return snapshot === null || snapshot.status === 'complete' ? null : snapshot.objective
}

/**
 * 技能名 → 喂给模型的正文。
 *
 * **走 omp 官方的展开路径**：`buildSkillPromptMessage` 读 SKILL.md、剥 frontmatter、渲染
 * userInvocationTemplate —— 自己读盘拼正文就是第二套格式，而模板是上游的、会变。
 */
async function skillPromptOf(
  session: OmpAgentSessionLike,
  name: string,
  args: string,
): Promise<{ message: string; details: unknown }> {
  const skill = session.skills.find((entry) => entry.name === name)
  if (skill === undefined || skill.filePath === undefined || skill.baseDir === undefined) {
    throw new AppError(SystemErrorCode.notFound, `这个技能现在不在会话里：${name}`)
  }
  const built = await buildSkillPromptMessage(
    { name: skill.name, filePath: skill.filePath, baseDir: skill.baseDir },
    { args },
    'user',
  )
  return { message: built.message, details: built.details }
}

/**
 * SubmitInput 的图片与文件在这里转成 omp 要的形状。直接 `session.prompt(submit.text)` 会把图片整条丢掉。
 */
async function deliverPrompt(
  session: OmpAgentSessionLike,
  submit: {
    readonly text: string
    readonly images: readonly { readonly path: string; readonly mime: string }[]
    readonly files: readonly { readonly path: string; readonly name: string }[]
    readonly skills: readonly string[]
    readonly context?: SubmitInput['context']
  },
  skillMessage: SkillPromptMessage | null,
  images?: readonly { readonly path: string; readonly mime: string; readonly base64: string }[],
): Promise<boolean> {
  /* 准备是**同步**的，所以下面那句 prompt 在同一个刻度里发出 —— 晚一个刻度屏幕就多等一帧才真的开始 */
  const prepared = prepareFor(session, submit, 'turn', images)
  if (skillMessage !== null) {
    return await session.promptCustomMessage(skillMessage as unknown as Record<string, unknown>)
  }
  return await session.prompt(
    prepared.text,
    prepared.imageContents.length === 0 ? undefined : ({ images: prepared.imageContents } as Record<string, unknown>),
  )
}

/** SubmitInput → omp 输入：图片 / 普通文件只有这一处（技能展开见 expandSkillMessage） */
function prepareFor(
  _session: OmpAgentSessionLike,
  submit: {
    readonly text: string
    readonly images: readonly { readonly path: string; readonly mime: string }[]
    readonly files: readonly { readonly path: string; readonly name: string }[]
    readonly skills: readonly string[]
    readonly context?: SubmitInput['context']
  },
  deliverAs: SubmitInput['deliverAs'],
  images?: readonly { readonly path: string; readonly mime: string; readonly base64: string }[],
) {
  return preparePrompt(
    {
      text: submit.text,
      images: submit.images,
      files: submit.files,
      skills: submit.skills,
      deliverAs,
      context: submit.context,
    },
    images === undefined ? {} : { loadedImages: images },
  )
}

function agentIdNote(sessionKey: string): string {
  return sessionKey
}

/**
 * 计划模式控制器：持「进模式前那份活动工具集」并负责还原，装 `setPlanProposalHandler` 把 agent 写
 * `xd://propose` 时的计划问成 `kind:'plan'` 卡片。批准时工具结果一返回，omp 就带着还原后的完整工具集
 * 在同一轮继续跑，不需要用户再发一句话。
 */
function createPlanner(d: {
  readonly session: OmpAgentSessionLike
  readonly broker: InteractionBroker
  readonly root: SettingsScope
  readonly logger: Logger
  readonly emitControls: () => void
}): {
  setPlanMode(enabled: boolean): Promise<void>
  isPlanModeOn(): boolean
} {
  let planTools: readonly string[] | undefined

  const propose = async (title: string): Promise<unknown> => {
    const proposal = await resolvePlanProposal(d.session, title)
    const answer = await d.broker.ask(
      planInteraction({
        title: proposal.title,
        planFilePath: proposal.planFilePath,
        markdown: proposal.planContent,
      }),
    )

    const handled = await settlePlanProposal({
      session: planSessionOf(d.session),
      details: { planFilePath: proposal.planFilePath, title: proposal.title, planExists: true },
      markdown: proposal.planContent,
      outcome: planOutcomeOf(answer),
    })
    if (!handled.approved) return handled.result

    /*
     * 批准：还原工具集（做完模型才真能动手，并在同一轮里继续跑）、把这份计划存一份（omp 的 autosave，
     * 失败只记 warn），再补一次 controls —— 模式变化发生在这一次工具调用里，选择器只有收到事件才会变。
     */
    const restore = planTools
    planTools = undefined
    if (restore !== undefined) await d.session.setActiveToolsByName?.([...restore])
    await autosaveApprovedPlanOf(d, proposal.title, proposal.planContent)
    d.emitControls()
    return handled.result
  }

  return {
    async setPlanMode(enabled: boolean): Promise<void> {
      const next = await applyPlanMode({
        session: planSessionOf(d.session),
        root: d.root,
        enabled,
        planTools,
        onProposal: enabled ? propose : null,
      })
      planTools = next.planTools
    },
    isPlanModeOn: () => d.session.getPlanModeState?.()?.enabled === true,
  }
}

function planLocalOptions(session: PlanArtifactSession): LocalProtocolOptions {
  return {
    getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
    getSessionId: () => session.sessionManager.getSessionId(),
  }
}

/** 走 omp 自己的 `resolveApprovedPlan` 解出文件、正文与标题 —— 自己拼路径就是第二份真身，换会话、改布局都会错位 */
async function resolvePlanProposal(
  session: OmpAgentSessionLike,
  title: string,
): Promise<{ readonly planFilePath: string; readonly planContent: string; readonly title: string }> {
  const [{ resolveApprovedPlan }, { readPlanFile, listPlanFiles }] = await Promise.all([
    import('@oh-my-pi/pi-coding-agent/plan-mode/approved-plan'),
    import('@oh-my-pi/pi-coding-agent/plan-mode/plan-files'),
  ])
  const localProtocolOptions = planLocalOptions(session)
  const cwd = session.sessionManager.getCwd()
  return await resolveApprovedPlan({
    suppliedTitle: title,
    statePlanFilePath: session.getPlanModeState?.()?.planFilePath ?? DEFAULT_PLAN_FILE,
    readPlan: async (url) => await readPlanFile(url, { localProtocolOptions, cwd }),
    listPlanFiles: async () => await listPlanFiles({ localProtocolOptions }),
  })
}

/** 把批准的这份计划抄到 omp 的 autosave 目录（`plan.autosave`，默认关）；关掉时是「什么都没做」而不是失败 */
async function autosaveApprovedPlanOf(
  d: { readonly session: OmpAgentSessionLike; readonly logger: Logger },
  title: string,
  planContent: string,
): Promise<void> {
  try {
    const { autosaveApprovedPlan } = await import('@oh-my-pi/pi-coding-agent/plan-mode/plan-autosave')
    await autosaveApprovedPlan({
      settings: d.session.settings as unknown as Settings,
      cwd: d.session.sessionManager.getCwd(),
      title,
      planContent,
    })
  } catch (error) {
    d.logger.warn('plan autosave failed', { error: String(error) })
  }
}

interface EventPump {
  readonly session: OmpSession
  readonly projector: LiveProjector
  readonly goal: GoalHost
  readonly faults: EventFaults
  /** 显示经过里最近那一条压缩摘要（压缩收口时读 tokensAfter 用） */
  readonly latestCompaction: () => OmpMessage | undefined
  /** info 级 notice 与「重试成功」只落日志，不上屏 */
  readonly logger: Logger
  /** 每条事件翻译完之后：现读待办 / 后台作业的真身（它们没有自己的增量事件） */
  readonly afterEvent: (type: string) => void
  /** 这个工具要不要参数流式上屏（EngineToolSpec.streamInput） */
  readonly streamsInput: (toolName: string) => boolean
}

const TOOL_EVENTS = new Set(['tool_execution_start', 'tool_execution_update', 'tool_execution_end'])

/** 不认识的值按 info 处理：宁可不上屏，也不把不认识的东西画成报错 */
function noticeLevelOf(value: unknown): 'error' | 'warning' | 'info' {
  return value === 'error' || value === 'warning' ? value : 'info'
}

/** 一条事件的翻译：只做事、不管异常，抛出去交给 `handleOmpEvent` 处置。`agent_end` 是收尾类，走 `endTurn` */
function dispatchOmpEvent(event: Record<string, unknown>, pump: EventPump): void {
  const { session, projector } = pump
  switch (event.type) {
    case 'message_update':
      applyMessageUpdate(event, pump)
      break
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end':
      applyToolEvent(event.type, event, pump)
      break
    case 'message_start': {
      /* 助手消息一开始就计数：历史那条路按同一个口径数（见 frame-ids.ts），两边对同一段话给出同一个号 */
      if (startedRoleOf(event.message) === 'assistant') projector.assistantMessageStart()
      claimStartedMessage(event.message, session)
      break
    }
    case 'message_end': {
      const message = event.message as Parameters<OmpSession['emitUsageFrom']>[0] | undefined
      if (message !== undefined) session.emitUsageFrom(message)
      /* 上下文那一格跟着每一条落地消息重报；放在样本之后，屏幕先拿到账、再拿到占用 */
      session.reportContextUsage()
      break
    }
    case 'queue_update':
      session.reconcileQueue(
        Array.isArray(event.steering) ? (event.steering as string[]) : [],
        Array.isArray(event.followUp) ? (event.followUp as string[]) : [],
      )
      break
    case 'model_changed':
    case 'thinking_level_changed':
    case 'goal_updated':
      session.controlsChanged()
      break
    case 'notice':
      applyNotice(event, pump)
      break
    case 'auto_compaction_start':
      session.requestTimeline(projector.compactionStart({ reason: event.reason, action: event.action }))
      break
    /*
     * 收口：把那一格标成做完 / 取消 / 失败（跳过就撤掉），再重报一次上下文占用（压完圆环要立刻掉下来）。
     *
     * **不再整页重取**（审查 R-21-1/2）：屏幕上的东西都是增量那条路画的，压缩并不改写它们；从前在这里
     * timelineReset，一来重取的那一页是按「压缩后的模型上下文」算的 —— 前文全没了；二来重置会丢掉还没
     * 发出去的关门那一帧，换上历史那一格的 running，于是一直停在「正在压缩上下文…」。
     */
    case 'auto_compaction_end':
      applyCompactionEnd(event, pump)
      break
    /*
     * 自动重试：一次重试过程在时间线上只占一格（retryStart / retryEnd 原地改写同一帧）。
     * 不接它，服务商抖动的那几十秒在屏幕上就是「卡住了」；成功之后那一格由界面收起，后面紧跟正常回复。
     */
    case 'auto_retry_start':
      session.requestTimeline(projector.retryStart(retryStartOf(event)))
      break
    case 'auto_retry_end':
      if (event.success === true) pump.logger.info('omp auto retry succeeded', { attempt: event.attempt ?? null })
      session.requestTimeline(projector.retryEnd(retryEndOf(event)))
      break
    default:
      break
  }
}

/** 助手消息的增量：文本 / 思考正文各一帧；工具参数增量走 streamToolInput */
function applyMessageUpdate(event: Record<string, unknown>, pump: EventPump): void {
  const { session, projector } = pump
  const assistant = event.assistantMessageEvent as Record<string, unknown> | undefined
  const deltaType = assistant?.type
  if (deltaType === 'toolcall_start' || deltaType === 'toolcall_delta' || deltaType === 'toolcall_end') {
    if (assistant !== undefined) streamToolInput(assistant, pump)
    return
  }
  const delta = assistant?.delta
  if (typeof delta !== 'string') return
  /* 块在这条助手消息 content 里的下标：帧号由它派生，重开之后历史那条路给出同一个号（frame-ids.ts） */
  const index = typeof assistant?.contentIndex === 'number' ? assistant.contentIndex : undefined
  if (deltaType === 'text_delta') session.requestTimeline(projector.textDelta(delta, index))
  else if (deltaType === 'thinking_delta') session.requestTimeline(projector.thinkingDelta(delta, index))
}

/** 工具开始 / 增量 / 结束：同一格按 toolCallId 整格替换 */
function applyToolEvent(eventType: string, event: Record<string, unknown>, pump: EventPump): void {
  const { session, projector } = pump
  const toolCallId = String(event.toolCallId)
  const toolName = String(event.toolName)
  if (eventType === 'tool_execution_start') {
    session.requestTimeline(
      projector.toolStart({
        toolCallId,
        toolName,
        args: event.args,
        ...(typeof event.intent === 'string' ? { intent: event.intent } : {}),
      }),
    )
    /* 先上调用、再补题组的号：卡片锚的是这条调用 */
    session.onToolStart(toolCallId, toolName)
    return
  }
  if (eventType === 'tool_execution_update') {
    session.requestTimeline(projector.toolUpdate({ toolCallId, toolName, partial: event.partialResult }))
    return
  }
  session.requestTimeline(
    projector.toolEnd({
      toolCallId,
      toolName,
      result: event.result,
      ...(event.isError === true ? { isError: true } : {}),
    }),
  )
  session.onToolEnd(toolCallId, toolName)
}

/** omp 的通知：info 只进日志（那是 TUI 状态栏的东西），上屏才是对话内容 */
function applyNotice(event: Record<string, unknown>, pump: EventPump): void {
  const level = noticeLevelOf(event.level)
  const message = String(event.message)
  const source = typeof event.source === 'string' ? event.source : undefined
  if (level === 'info') {
    pump.logger.debug('omp notice', { source: source ?? null, message })
    return
  }
  pump.session.requestTimeline(pump.projector.notice(level, message, source))
}

/** 压缩收口：改写那一格，再重报上下文占用（压完圆环要立刻掉下来）；**不整页重取**（审查 R-21-1/2） */
function applyCompactionEnd(event: Record<string, unknown>, pump: EventPump): void {
  const persisted = event.result === undefined || event.result === null ? undefined : pump.latestCompaction()
  pump.session.requestTimeline(pump.projector.compactionEnd(compactionEndPayload(event, persisted)))
  pump.session.reportContextUsage()
}

/**
 * 工具参数的增量（pi-ai 的 toolcall_*）：start / delta 的那一块在 `partial.content[contentIndex]`，end 直接带
 * `toolCall`。块里的 `arguments` 是服务商边流边解析出来的那一份（攒够一截才重解析，见 parseStreamingJsonThrottled）。
 * 只有声明了 streamInput 的工具往下走；其余工具的参数照旧等 tool_execution_start 一次给齐。
 */
function streamToolInput(assistant: Record<string, unknown>, pump: EventPump): void {
  const final = assistant.type === 'toolcall_end'
  const block = final ? assistant.toolCall : contentBlockOf(assistant.partial, assistant.contentIndex)
  if (typeof block !== 'object' || block === null) return
  const { id, name, arguments: args } = block as Record<string, unknown>
  if (typeof id !== 'string' || id === '' || typeof name !== 'string' || !pump.streamsInput(name)) return
  pump.session.requestTimeline(pump.projector.toolInput({ toolCallId: id, toolName: name, args: args ?? {}, final }))
}

function contentBlockOf(message: unknown, index: unknown): unknown {
  if (typeof index !== 'number' || typeof message !== 'object' || message === null) return undefined
  const content = (message as { readonly content?: unknown }).content
  return Array.isArray(content) ? content[index] : undefined
}

/** 事件泵分流：分类只看 `event.type` 字符串，`agent_end` 特判，工具类失败就地降级那一格，其余只记日志 */
function handleOmpEvent(event: Record<string, unknown>, pump: EventPump): void {
  const eventType = typeof event.type === 'string' ? event.type : 'unknown'
  /* 目标控制器**先**看这一条（omp 的 RPC 宿主同一个次序）：agent_end 时它要先决定续不续跑 */
  guarded(pump, `${eventType}.goal`, () => pump.goal.observe(event))
  if (eventType === 'agent_end') endTurn(pump)
  else {
    try {
      dispatchOmpEvent(event, pump)
    } catch (error) {
      reportDispatchFault(eventType, event, error, pump)
    }
  }
  guarded(pump, `${eventType}.side`, () => pump.afterEvent(eventType))
}

/** 一段可能抛错的副作用：抛了就记一条带上下文的账，不连累同一条事件的其它段 */
function guarded(pump: EventPump, scope: string, fn: () => void): void {
  try {
    fn()
  } catch (error) {
    pump.faults.report(scope, error)
  }
}

/** 分派失败：先记账；工具类事件就地降级那一格（同 id 整格替换，覆盖一次就重新一致） */
function reportDispatchFault(eventType: string, event: Record<string, unknown>, error: unknown, pump: EventPump): void {
  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : null
  pump.faults.report(eventType, error, toolCallId === null ? {} : { toolCallId })
  if (TOOL_EVENTS.has(eventType) && toolCallId !== null) degradeTool(eventType, event, toolCallId, pump)
}

/** 投影失败就地降级这一格：`frame.upsert` 是同 id 整格替换，覆盖一次就重新一致 */
function degradeTool(eventType: string, event: Record<string, unknown>, toolCallId: string, pump: EventPump): void {
  const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool'
  const ended = eventType === 'tool_execution_end' ? event.isError === true : null
  try {
    pump.session.requestTimeline(pump.projector.toolFallback({ toolCallId, toolName, ended }))
  } catch (error) {
    pump.faults.report(`${eventType}.fallback`, error, { toolCallId })
  }
}

/** `agent_end`：收口与上下文读数各自兜住，互不连累；最后结清这一轮的异常账 */
function endTurn(pump: EventPump): void {
  try {
    pump.session.finishTurn()
  } catch (error) {
    pump.faults.report('agent_end', error)
  }
  try {
    /* 轮终再报一次：收尾（压缩标记、最后一条消息之后的变动）也要落到读数里 */
    pump.session.reportContextUsage()
  } catch (error) {
    pump.faults.report('agent_end.contextUsage', error)
  }
  pump.faults.settle()
}
