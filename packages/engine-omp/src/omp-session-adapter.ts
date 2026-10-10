import type { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import { buildSkillPromptMessage } from '@oh-my-pi/pi-coding-agent/extensibility/skills'
import type { LocalProtocolOptions } from '@oh-my-pi/pi-coding-agent/internal-urls/local-protocol'
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
import { toContextUsage } from './context-usage'
import { EventFaults } from './event-faults'
import { InteractionBroker } from './interactions/broker'
import { planInteraction, planOutcomeOf } from './interactions/plan'
import { createUiContext } from './interactions/ui-context'
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
import { lastTurnOrdinal, type OmpMessage, projectHistoryPage } from './projector/history'
import { LiveProjector } from './projector/live'
import { SubagentLedger } from './projector/subagents'
import {
  expandSkillMessage,
  imageContentsOf,
  isUserSkillMessage,
  type LoadedImage,
  loadImages,
  preparePrompt,
  type SkillPromptMessage,
} from './prompt'
import { OmpSession } from './session'
import type { SettingsScope } from './settings-access'

/** `computeSessionContextBreakdown` 收的是 omp 自己的 AgentSession；本层只按结构持有它 */
type BreakdownSession = Parameters<typeof computeSessionContextBreakdown>[0]

/** omp 的 AgentSession 面上我们真正用到的那几格（按结构收窄，不绑 omp 深层类型） */
interface OmpAgentSessionLike {
  readonly sessionId: string
  readonly sessionFile: string | undefined
  /**
   * 会话此刻正在用的模型（AgentSession 的公开 getter，未选出来时是 undefined）。
   *
   * 控件表要报「这条会话实际会用哪一条」（12 页 §7.7 的表：model 读 `session.model`），
   * 所以控件初值不能只看传进来的 spec —— SDK 自己挑的那一条也要读得回来。
   */
  readonly model?: { readonly provider: string; readonly id: string } | undefined
  /** 会话此刻的思考档（同上，读回用；未选出来时是 undefined）。 */
  readonly thinkingLevel?: string | undefined
  readonly settings: SettingsScope
  readonly messages: readonly OmpMessage[]
  /**
   * 会话作用域的落点：`local://` 计划文件与工作目录都从它算（omp 的 SessionManager）。
   *
   * **不要在 AgentSession 上直接读 artifactsDir / cwd** —— 它没有这两个属性（真实形状里
   * 只有 sessionManager，见 agent-session.d.ts）：读出来恒是 undefined，`local://` 会退到
   * `os.tmpdir()/omp-local/<id>`，agent 写在 artifacts 目录里的计划一份也解不出来。
   */
  readonly sessionManager: {
    getArtifactsDir(): string | null
    getSessionId(): string
    getCwd(): string
  }
  /** 会话此刻的技能表；`filePath` / `baseDir` 是官方 buildSkillPromptMessage 要的两格 */
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
   * 上下文用量。字段名是 omp 的 `{ tokens, contextWindow, percent }`（pi-tui 的
   * status-line/types），**不是** `{ usedTokens, windowTokens }`。
   *
   * 旧代码按后者读，两个名字在真实 SDK 里都不存在，于是每一次都被判成「会话还没报过」——
   * 输入框那颗上下文圆环因此永远不画（真机故障）。这里的形状照 SDK 声明收窄。
   */
  getContextUsage(): { readonly tokens?: number; readonly contextWindow?: number } | undefined
  getAvailableThinkingLevels?(): readonly string[]
  /** 这一家 agent 此刻可用的模型清单（omp 的 ModelControls.getAvailableModels，已按白名单过滤） */
  getAvailableModels?(): readonly {
    readonly provider: string
    readonly id: string
    readonly name?: string
    readonly reasoning?: boolean
    readonly input?: readonly string[]
  }[]
  /** 换模型（omp 的 AgentSession.setModel；不落盘由 persist:false 说清） */
  setModel?(model: unknown, role?: string, options?: { readonly persist?: boolean }): Promise<unknown>
  getLastAssistantMessage(): { readonly stopReason?: string; readonly errorMessage?: string } | undefined
  /* —— 计划模式与目标模式（04 §2.4 / 12 §7.7；签名照 agent-session.d.ts 收窄） —— */
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
  sendPlanModeContext?(options?: { deliverAs?: 'steer' | 'followUp' | 'nextTurn' | 'aside' }): Promise<void>
  sendGoalModeContext?(options?: { deliverAs?: 'steer' | 'followUp' | 'nextTurn' | 'aside' }): Promise<void>
}

export interface WrapOmpSessionInput {
  readonly spec: OpenSessionSpec
  readonly settings: SettingsScope
  readonly agentSession: unknown
  readonly setToolUIContext: (ui: unknown, hasUI: boolean) => void
  readonly mcpManager: unknown
  readonly tools: ReadonlyMap<string, EngineToolSpec>
  readonly logger: Logger
  /** 子代理总线的两个频道订阅（没有总线时给 null） */
  readonly subagentBus: { on(channel: string, listener: (data: unknown) => void): () => void } | null
  /** 让引擎把 UI 接上（initializeExtensions 由调用方提供，见 create-engine） */
  readonly initializeExtensions: (session: unknown, ui: unknown) => Promise<void>
  /** 模型解析的结果：写进控件用（null 表示交给 SDK 兜底） */
  readonly model: { provider: string; id: string } | null
  readonly thinking: string | null
  /**
   * 按 ref 查**模型目录**（静态）：名字与思考梯子烤在目录里，不需要开会话就能拿到。
   *
   * 会话侧那两口（getAvailableModels / getAvailableThinkingLevels）在会话还没水合时是空的；
   * 控件初值要在那一刻也答得出来，所以入口页与这一层共用同一个产地：注册表。
   * 查不到（下架的 id、目录里没有）就交 null，不编一条。
   */
  readonly modelCatalog: (ref: { readonly provider: string; readonly id: string }) => {
    readonly label: string
    readonly efforts: readonly string[]
    readonly defaultLevel: string | null
  } | null
  /**
   * 测试缝（R-08-1）：替换图片读盘，用来数「每张图只读一次」。生产不传，走真实 fs。
   */
  readonly loadImageFiles?: (
    images: readonly { readonly path: string; readonly mime: string }[],
  ) => Promise<readonly LoadedImage[]>
}

/** 把 omp 的 AgentSession 组装成 EngineSession（12 页 §6.3 第 7 步 / §7） */
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
  // 重开会话：把累加器摆到屏幕上已有的位置，否则第一句话会盖掉屏幕上已有的轮
  projector.seat(lastTurnOrdinal(session.messages))
  /*
   * 上下文用量：读数取 omp 的 getContextUsage，构成取 omp 自己的 computeSessionContextBreakdown
   * （它 /context 面板印的就是这一份）。
   *
   * 不自己按 getContextBreakdown 那五格折：正本把「技能」从系统提示词里减出去、还算出空闲
   * 与自动压缩缓冲，自己折就会与它在屏幕上显示的那份对不上（legacy bridge.ts 同一条注释）。
   *
   * **每次现读**，不在这里存第二份：非消息四项 omp 自己按 settings revision 与数组身份记忆化，
   * 所以按事件重算不贵（legacy 的 reportUsage 也是这么按事件调的）。
   *
   * 算不出构成只是没有明细 —— 屏幕退成只画总条，不把整张控件表拖垮，所以这里吞掉并留痕。
   */
  const readContextUsage = (): ContextUsage | null => {
    let breakdown: Parameters<typeof toContextUsage>[1]
    try {
      breakdown = computeSessionContextBreakdown(session as unknown as BreakdownSession)
    } catch (cause) {
      input.logger.warn('context breakdown failed', { error: String(cause) })
    }
    return toContextUsage(session.getContextUsage(), breakdown)
  }

  const ui = createUiContext(broker, { grantTool: (tool) => grantToolForSession(input.settings, tool) })
  /*
   * 计划模式的控制器（04 §2.4 / 12 §7.7）：
   * - 持「进模式前那份工具集」与「什么时候该还原」，因为这两件事跨一次提交；
   * - 装 omp 要的 PlanProposalHandler：agent 写 `xd://propose` 时它被调，
   *   在这里把计划问成产品卡片、按答复交出工具结果。
   */
  const planner = createPlanner({
    session,
    broker,
    root: input.settings,
    logger: input.logger,
    /*
     * 批准的补报走 ompSession 自己那条事件线（它就是 controls 的产地）。这个箭头只是在
     * 定义时先引用、调用时再求值 —— planner 与 ompSession 互相需要，只能这样接上。
     */
    emitControls: () => ompSession.controlsChanged(),
  })
  const ompSession = new OmpSession(
    {
      spec: input.spec,
      logger: input.logger,
      broker,
      projector,
      /*
       * R-08-1：图片在 OmpSession.runTurn 里异步读一次，结果既画时间线又交给 prompt，
       * 两处共用同一份 base64（不再同步读两遍）。
       */
      loadImages: async (images) => await (input.loadImageFiles ?? loadImages)(images),
      promptWithImages: async (submit, images, skillMessage) =>
        await deliverPrompt(session, submit, skillMessage, images),
      /*
       * 排队 / 插话的投递。
       *
       * 三种投递共用同一份 preparePrompt：`text` 是**投递正文**（用户原文 + 每个文件一行
       * `@<绝对路径>`，见 prompt.ts 的 wireTextOf）。先前这里发的是 `submit.text`，文件
       * 在排队 / 插话这条路上被静默丢掉（turn 那条路会拼 @路径，两边不对称）—— 队列正文
       * 与 omp 队列对账、removeQueuedMessage、message_start 认领都必须认这一份。
       */
      steer: async (submit, deliverAs, skillMessage) => {
        const prepared = preparePrompt(submit, {})
        if (skillMessage !== null) {
          await session.promptCustomMessage(skillMessage as unknown as Record<string, unknown>, {
            streamingBehavior: deliverAs,
            /*
             * omp 的队列 chip 与 removeQueuedMessage 都认 `queueChipText`（实测：
             * agent-session.ts 的 #queueCustomMessage 把它写进 details.__queueChipText，
             * getQueuedMessages → queueChipText(message) 先读它）。所以技能分支的
             * wireText 就是用户原文，对账与撤回两边同一份字符串。
             */
            queueChipText: submit.text,
          })
          return { wireText: submit.text }
        }
        if (deliverAs === 'steer') await session.steer(prepared.text, [...prepared.imageContents])
        else await session.followUp(prepared.text, [...prepared.imageContents])
        return { wireText: prepared.text }
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
      /*
       * 控件表读的是**会话此刻的真相**（12 页 §7.7）：omp 自己的 model_changed /
       * thinking_level_changed 事件只会叫我们重发一次表，表里的值必须现读现报 ——
       * 读不到（还没选出来）才退回下面 setModel / setThinking 记下的那一份。
       */
      liveModel: () => {
        const current = session.model
        return current === undefined ? null : { provider: current.provider, id: current.id }
      },
      liveThinking: () => session.thinkingLevel ?? null,
      lastAssistant: () => session.getLastAssistantMessage(),
      thinkingChoices: () => thinkingLevelsOf(session),
      /*
       * 模型候选：会话现报的清单（omp 的 getAvailableModels，已按白名单过滤）。
       * label 用模型自己的名字（`name ?? id`），与 legacy 选择器同一拼法。
       */
      modelChoices: () => modelsOf(session),
      modelLabel: (model) => input.modelCatalog(model)?.label ?? `${model.provider}/${model.id}`,
      /* 会话没水合时用**这条模型静态的梯子**兜底（模型目录里烤好的 efforts）；查不到就空表 */
      thinkingFallback: (model) => (model === null ? [] : (input.modelCatalog(model)?.efforts ?? [])),
      defaultThinking: (model) => (model === null ? null : (input.modelCatalog(model)?.defaultLevel ?? null)),
      setModelOnSession: async (model) => {
        /*
         * 从这一家 agent 的可用清单里挑出那一条再交给 SDK：omp 的 setModel 收的是 Model
         * 实例，不是 ref。找不到（不在白名单、下架）时如实抛，不静默换别的。
         */
        const target = (session.getAvailableModels?.() ?? []).find(
          (entry) => entry.provider === model.provider && entry.id === model.id,
        )
        if (target === undefined) {
          throw new AppError(EngineErrorCode.modelNotFound, `找不到所选模型：${model.provider}/${model.id}`)
        }
        if (session.setModel === undefined) {
          throw new AppError(SystemErrorCode.internal, '这条会话不支持切换模型')
        }
        // persist:false —— 只影响本会话，不改全局默认（12 页 §7.7）
        await session.setModel(target, undefined, { persist: false })
      },
      setThinkingOnSession: (level) => session.setThinkingLevel(level, false),
      /*
       * 上下文用量：读数 + 构成。
       *
       * 构成取 omp 自己的 `computeSessionContextBreakdown`（它 /context 面板印的就是这一份），
       * 不自己按 `getContextBreakdown` 那五格折：正本把「技能」从系统提示词里减出去、还算出
       * 空闲与自动压缩缓冲，自己折就会与它在屏幕上显示的那份对不上（legacy bridge.ts 同一条）。
       *
       * **每次现读**，不在这里存第二份：非消息四项 omp 自己按 settings revision 与数组身份
       * 记忆化，所以按事件重算不贵（legacy 的 reportUsage 也是这么按事件调的）；存一份反而
       * 会与「控件表现读会话真相」这条规矩打架（见下面 model / thinking 的头注）。
       *
       * 算不出构成只是没有明细 —— 屏幕退成只画总条，不把整张控件表拖垮，所以这里吞掉并留痕。
       */
      contextUsage: readContextUsage,
      skillMessage: async (submit, images) => {
        /* R-08-1：turn 那条路把已读好的图传进来，这里就不再读第二遍 */
        const imageContents = images === undefined ? preparePrompt(submit, {}).imageContents : imageContentsOf(images)
        return await expandSkillMessage(submit, imageContents, {
          availableSkills: session.skills.map((skill) => skill.name),
          skillMessage: (name, args) => skillPromptOf(session, name, args),
        })
      },
      /*
       * 计划模式 / 目标模式（04 §2.4、12 §7.7）：真正下到 omp 的会话状态上，
       * 会话只负责持状态、兑现卡片、重报控件。planTools 是进模式前记下的工具集，
       * 退出或批准之后按它原样还原。
       */
      applyPlanMode: (enabled) => planner.setPlanMode(enabled),
      applyGoal: async (goal) => {
        await applyGoal({ session: goalSessionOf(session), root: input.settings, goal })
      },
      pauseGoal: async () => {
        await pauseGoalMode({ session: goalSessionOf(session) })
      },
      resumeGoal: async () => {
        await resumeGoalMode({ session: goalSessionOf(session), root: input.settings })
      },
      planAvailable: () => availabilityOf(input.settings).plan,
      goalAvailable: () => availabilityOf(input.settings).goal,
      livePlanMode: () => planner.isPlanModeOn(),
      liveGoal: () => goalOf(session),
      liveGoalSnapshot: () => goalSnapshotOf(session),
      page: async (_agentId, beforeTurnId) =>
        projectHistoryPage(session.messages, beforeTurnId, { isTurnOpen: projector.isTurnOpen }),
      now: () => systemClock.now(),
    },
    { sessionId: session.sessionId, sessionFile: session.sessionFile ?? '' },
  )
  void agentIdNote(sessionKey)
  // omp 在某些情况下会丢弃用户输入（例如压缩期间），不接这个回调用户消息就会凭空消失。
  // omp 知识 #8：必须接上 setPromptDropped —— omp 在某些情况下会丢弃用户输入（例如压缩期间），
  session.setPromptDropped((prompt) => ompSession.emitPromptDropped(prompt.text))
  /*
   * 事件泵的上下文（R-02 §2.6）：`faults` 是这次修复的要害 —— 先前整个 switch 包在
   * 一个吞掉一切的 catch 里，异常被完全咽下（不记日志、不上屏、也没有兜底）。
   */
  const pump: EventPump = {
    session: ompSession,
    projector,
    faults: new EventFaults(input.logger, () => projector.turnOrdinal),
    logger: input.logger,
  }
  const subscriptions = [
    ompSession.attachBroker(),
    // omp 的 subscribe 直接返回退订函数：包一层再存，dispose 时真的退订
    toSub(session.subscribe((event) => handleOmpEvent(event, pump))),
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
  }
  ompSession.attach(subscriptions)
  // omp 知识 #6：hasUI + setToolUIContext + initializeExtensions 三者缺一不可
  input.setToolUIContext(ui, true)
  await input.initializeExtensions(session, ui)
  /*
   * 控件初值：模型与档位解析的结果要让 UI 立刻看得到。
   *
   * **解析不出模型时不写**（`input.model === null`）。这里原先写的是
   * `setModel(input.model ?? { provider: '', id: '' })`：一个空 ref 会把控件表的
   * `model.current` 写成 `{provider:'', id:''}`，而契约要求两格都是非空串 ——
   * `controls.get` 每次都在 Core 侧被 zod 退回，UI 那一排选择器永远拿不到表，
   * 输入框上沿挂出「没连上 agent，点击重试」（真机实测）。解析不出就是「这条会话
   * 的模型交给 SDK 挑」：把 `current` 留成 null 才与 §7.7 的「session.model」同一语义。
   */
  if (input.model !== null) await ompSession.setModel(input.model)
  if (input.thinking !== null) ompSession.setThinking(input.thinking)
  return ompSession
}

/** 该模型支持的思考档位（omp 的 getAvailableThinkingLevels）；取不到就给空表，不编四档 */
function thinkingLevelsOf(session: OmpAgentSessionLike): readonly string[] {
  try {
    return session.getAvailableThinkingLevels?.() ?? []
  } catch {
    return []
  }
}

/**
 * 这一家 agent 此刻可用的模型（omp 的 getAvailableModels）。
 *
 * label 用模型自己的名字，取不到名字才退回 id —— 屏幕上要的是人能认的名字，
 * provider/id 是 omp 内部的选择器拼法（真实故障：输入框显示的是 `deepseek/deepseek-v4-pro`）。
 */
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

/** 用户消息正文里的文本（认领插话要比对的就是它） */
function userTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as readonly { readonly type?: unknown; readonly text?: unknown }[])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

/** 把 omp 的「退订函数」包成 Disposable 形状 */
function toSub(unsubscribe: () => void): { dispose(): void } {
  return { dispose: unsubscribe }
}

/**
 * 一条 message_start 落到「是不是插话」上的判定（R-01 §3.4）。
 *
 * 两支：user 消息按投递正文认领（本轮自己的 prompt 由 OmpSession 那边按同一份正文排除）；
 * 用户技能消息走 promptCustomMessage，omp 发的是 custom 消息（`role: 'custom'`），
 * 认它要类型 + 归属两格都对 —— 自动加载的技能是 agent 自己塞的上下文，不算用户插话。
 * 单独一处是为了不把 handleOmpEvent 的分支复杂度再推高一档（lint 的上限 40）。
 */
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
    const text = userTextOf(message.content)
    if (text !== '') session.onUserMessageStart(text)
    return
  }
  if (isUserSkillMessage(message)) session.onSkillMessageStart()
}

/**
 * `OmpAgentSessionLike` → `PlanCapableSession`：两个形状说的是同一件事，
 * 但计划那几格在会话面上是可选的（老版本 / 哑实现没有），缺失时**如实报错**而不是静默跳过 ——
 * 静默跳过会让「进计划模式」看起来成功了，实际一个工具都没收起来。
 */
function planSessionOf(session: OmpAgentSessionLike): PlanCapableSession {
  /* 显式标出类型：TS 只对「有显式类型标注的 const」把 never 返回的调用当成控制流终点，
     下面 `if (apply === undefined) missing()` 靠它把 apply 收窄成非空。 */
  const missing: () => never = () => {
    throw new AppError(SystemErrorCode.internal, '这条会话不支持计划模式')
  }
  return {
    getEnabledToolNames: () => session.getEnabledToolNames?.() ?? missing(),
    hasBuiltInTool: (name) => session.hasBuiltInTool?.(name) ?? missing(),
    /*
     * 缺席判据要落在**方法本身**上：`await` 一个 void 方法的产物恒是 undefined，
     * 用 `(await …) ?? missing()` 会把「方法在、正常返回」也判成不支持 —— 真人路径上
     * 就是进模式当场抛内部错（回归用例 plan-proposal.test.ts 钉住这一条）。
     *
     * 判空时**别把方法从会话上摘下来**：omp 的 setActiveToolsByName 是类方法，内部读
     * 自己的私有字段（`this.#tools`）。`const apply = session.setActiveToolsByName`
     * 之后再裸调会丢 this —— 真人路径上就是目标模式一设就报「undefined is not an
     * object (evaluating 'this.#tools')」、计划模式发不出去（真机缺陷回归用例
     * plan-goal-e2e.test.ts 的夹具以读 this 的方法钉住这一条）。
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

/** 同上，目标模式那一面 */
function goalSessionOf(session: OmpAgentSessionLike): GoalCapableSession {
  /* 同上：显式类型标注是 TS 的 never-返回控制流分析的判据。 */
  const missing: () => never = () => {
    throw new AppError(SystemErrorCode.internal, '这条会话不支持目标模式')
  }
  return {
    getEnabledToolNames: () => session.getEnabledToolNames?.() ?? missing(),
    hasBuiltInTool: (name) => session.hasBuiltInTool?.(name) ?? missing(),
    /*
     * 缺席判据要落在**方法本身**上：`await` 一个 void 方法的产物恒是 undefined，
     * 用 `(await …) ?? missing()` 会把「方法在、正常返回」也判成不支持 —— 真人路径上
     * 就是进模式当场抛内部错（回归用例 plan-proposal.test.ts 钉住这一条）。
     *
     * 同样别把方法从会话上摘下来：接收者一丢，omp 类的私有字段访问（`this.#tools`）
     * 当场抛错。
     */
    setActiveToolsByName: async (names) => {
      if (session.setActiveToolsByName === undefined) missing()
      await session.setActiveToolsByName(names)
    },
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
 * 会话此刻的目标快照；dropped 的那一档按「没有目标」报（legacy goalSnapshotOf 同此）。
 *
 * `budget-limited` → `blocked`（产品词表只有四档）；`completionCriterion` / `turnsUsed`
 * omp 里没有对应字段，恒报 null / 0，不编假值。
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

/**
 * 会话此刻的目标正文。dropped 与 complete 都按「没有目标」报（R-10）：这一格驱动输入框下方
 * 那颗「目标」开关，目标完成之后它要能重新打开（再发一句就建新目标）；完成那一档的面板
 * 仍由 goalSnapshot 如实报 complete。
 */
function goalOf(session: OmpAgentSessionLike): string | null {
  const snapshot = goalSnapshotOf(session)
  return snapshot === null || snapshot.status === 'complete' ? null : snapshot.objective
}

/**
 * 把技能名展开成喂给模型的正文（12 页 §7.6）。
 *
 * **走 omp 官方的展开路径**：`buildSkillPromptMessage` 读 SKILL.md、剥 frontmatter、
 * 渲染 userInvocationTemplate —— 「技能 → 消息」这件事上游只做在这一处，四个宿主各自调它。
 * 自己读盘拼正文就是第二套格式，而模板是上游的、会变（legacy bridge.ts 第 2264 行同此）。
 *
 * 名字对不上会话自己的技能表时**不静默**：那一枚 chip 指着一个此刻不存在的技能，
 * 报错比把字面命令送进模型好（后者是「看起来跑了其实没跑」）。
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
 * 投递一条输入（12 页 §7.6 + §7.4）。
 *
 * SubmitInput 的图片与文件在这里经 preparePrompt 转成 omp 要的形状：图片读盘转 base64
 * （超过 20 MB 抛 kernel.invalid_params）、普通文件以 @<绝对路径> 附在正文后。
 * 直接 `session.prompt(submit.text)` 会把图片整条丢掉 —— 那正是 legacy 图片用例要防的缺陷。
 */
async function deliverPrompt(
  session: OmpAgentSessionLike,
  submit: {
    readonly text: string
    readonly images: readonly { readonly path: string; readonly mime: string }[]
    readonly files: readonly { readonly path: string; readonly name: string }[]
    readonly skills: readonly string[]
  },
  skillMessage: SkillPromptMessage | null,
  /** R-08-1：已经读好的一份（turn 那条路给；缺席即自己同步读，排队 / 插话那条路） */
  images?: readonly { readonly path: string; readonly mime: string; readonly base64: string }[],
): Promise<boolean> {
  /*
   * 准备是**同步**的（图片读盘与正文拼接都不 await），所以下面那句 prompt 在同一个刻度里发出 ——
   * 投递晚一个刻度，屏幕上那一轮就要多等一帧才真的开始。
   */
  const prepared = prepareFor(session, submit, 'turn', images)
  // 技能消息由 OmpSession 那边先展开（它要读 SKILL.md），这里只负责投递
  if (skillMessage !== null) {
    return await session.promptCustomMessage(skillMessage as unknown as Record<string, unknown>)
  }
  return await session.prompt(
    prepared.text,
    prepared.imageContents.length === 0 ? undefined : ({ images: prepared.imageContents } as Record<string, unknown>),
  )
}

/** SubmitInput → omp 输入：图片 / 普通文件只有这一处（12 页 §7.6；技能展开见 expandSkillMessage） */
function prepareFor(
  _session: OmpAgentSessionLike,
  submit: {
    readonly text: string
    readonly images: readonly { readonly path: string; readonly mime: string }[]
    readonly files: readonly { readonly path: string; readonly name: string }[]
    readonly skills: readonly string[]
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
    },
    images === undefined ? {} : { loadedImages: images },
  )
}

function agentIdNote(sessionKey: string): string {
  return sessionKey
}

/**
 * 计划模式的控制器（04 §2.4 / §3.12、12 §7.7 / §8.5；产品负责人 2026-10-07 定稿）。
 *
 * 它把三件必须放在一起的事收在一处：
 * 1. 进/出模式时记下并还原那份活动工具集（`setActiveToolsByName` 是异步的，状态要跨调用保存）；
 * 2. 装 `setPlanProposalHandler`：agent 写 `xd://propose` 时把计划问成一张 `kind:'plan'` 卡片；
 * 3. 按人的答复交出 omp 要的工具结果，并在批准时退出计划模式、还原工具集。
 *
 * 「批准之后模型能在同一轮里继续执行」靠的是：答复在这一次工具调用里兑现，工具结果一返回，
 * omp 就带着（已经还原的）完整工具集继续跑，不需要用户再发一句话。
 */
function createPlanner(d: {
  readonly session: OmpAgentSessionLike
  readonly broker: InteractionBroker
  readonly root: SettingsScope
  readonly logger: Logger
  /** 批准之后模式真的变了：补一次 controls，计划选择器跟着变回「直接执行」 */
  readonly emitControls: () => void
}): {
  setPlanMode(enabled: boolean): Promise<void>
  isPlanModeOn(): boolean
} {
  /** 进模式前那份活动工具集；不在计划模式里时是 undefined */
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
     * 批准：退出计划模式那几步 `settlePlanProposal` 已经做完（登记参考路径 + 处理器置 null +
     * 状态清掉），这里接着做三件 ——
     *
     *   1. 还原工具集：做完模型才真的能动手，并且在**同一轮**里继续跑（这次批准就发生在
     *      `write xd://propose` 那次工具调用里，工具结果一返回它就带着全套工具往下走）；
     *   2. 把批准的这份计划存一份（omp 的 autosave，人不开关就什么都不做；失败只记 warn，
     *      存不下来不该把一次批准弄糟）；
     *   3. 补一次 controls：模式从「计划」变回「直接执行」是在这一次工具调用里发生的，
     *      UI 的选择器只有收到事件才会跟着变。
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

/** 会话作用域的 `local://` 落点：omp 自己那两格（sessionManager 的 artifactsDir 与 sessionId） */
function planLocalOptions(session: PlanArtifactSession): LocalProtocolOptions {
  return {
    getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
    getSessionId: () => session.sessionManager.getSessionId(),
  }
}

/**
 * 一次计划提交落在哪份文件上、写了什么、标题是什么（迁移 legacy `proposePlan` 的解析那一半）。
 *
 * 走 omp 自己的 `resolveApprovedPlan`：按 agent 给的标题推出 slug、扫描会话作用域的
 * artifacts、必要时退回计划状态里那条路径，一次把三者解出来 —— 自己拼路径就是第二份真身，
 * 换会话、改布局都会错位。正文由 `readPlanFile` 在那条 `local://` 上读（同一个落点）。
 *
 * 找不到文件时 `resolveApprovedPlan` 抛 ToolError，原样交给模型：它得知道计划没提交上去。
 */
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

/**
 * 把批准的这份计划抄到 omp 的 autosave 目录（`plan.autosave`，默认关）。
 *
 * 设置句柄是注册表那套的根 scope：`SettingsScope` 就是 `ScopeLike`，omp 的 autosave 只在签名上
 * 写死了具体的 `Settings` 类（它的宿主都持有那个类），而它真正要的只是两格设置与一个 cwd。
 * 关掉时返回 null，是「什么都没做」而不是失败。
 */
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

/**
 * 事件泵的上下文（R-02 §2.6）：三个东西每一条事件都要用，绑成一份传。
 *
 * 先前这里是「session + projector + ledger」三个位置参数，而 ledger 在函数里根本没用到
 * （函数尾部用一句丢弃它的空语句压 lint）—— 收进对象后，`faults` 才是泵真正需要的第三格。
 */
interface EventPump {
  readonly session: OmpSession
  readonly projector: LiveProjector
  readonly faults: EventFaults
  /** info 级 notice 与「重试成功」只落日志，不上屏（R-09） */
  readonly logger: Logger
}

/** 能用 omp 给的稳定 id 定位到某一格的事件（R-02 §2.1 原则 2 的补充规则 1） */
const TOOL_EVENTS = new Set(['tool_execution_start', 'tool_execution_update', 'tool_execution_end'])

/** omp notice 的级别；不认识的值按 info 处理：宁可不上屏，也不把不认识的东西画成报错（R-09） */
function noticeLevelOf(value: unknown): 'error' | 'warning' | 'info' {
  return value === 'error' || value === 'warning' ? value : 'info'
}

/**
 * 一条事件的翻译（12 页 §7.3、§9.1）。
 *
 * 这里只做事、不管异常：抛出去交给 `handleOmpEvent` 按事件类别处置（R-02 §2.6）。
 * `agent_end` 不在这一支 —— 它是收尾类，走 `endTurn`。
 */
function dispatchOmpEvent(event: Record<string, unknown>, pump: EventPump): void {
  const { session, projector } = pump
  switch (event.type) {
    case 'message_update': {
      const assistant = event.assistantMessageEvent as Record<string, unknown> | undefined
      const deltaType = assistant?.type
      const delta = assistant?.delta
      if (typeof delta !== 'string') break
      if (deltaType === 'text_delta') session.requestTimeline(projector.textDelta(delta))
      else if (deltaType === 'thinking_delta') session.requestTimeline(projector.thinkingDelta(delta))
      break
    }
    case 'tool_execution_start':
      session.requestTimeline(
        projector.toolStart({
          toolCallId: String(event.toolCallId),
          toolName: String(event.toolName),
          args: event.args,
          ...(typeof event.intent === 'string' ? { intent: event.intent } : {}),
        }),
      )
      break
    case 'tool_execution_update':
      session.requestTimeline(
        projector.toolUpdate({
          toolCallId: String(event.toolCallId),
          toolName: String(event.toolName),
          partial: event.partialResult,
        }),
      )
      break
    case 'tool_execution_end':
      session.requestTimeline(
        projector.toolEnd({
          toolCallId: String(event.toolCallId),
          toolName: String(event.toolName),
          result: event.result,
          ...(event.isError === true ? { isError: true } : {}),
        }),
      )
      break
    case 'message_start': {
      /*
       * 插话落地：omp 把注入的消息折进上下文时发这一条。
       *
       * user 消息按投递正文认领（本轮自己的 prompt 由会话那边按同一份正文排除）；
       * 用户技能消息走 promptCustomMessage，omp 发的是 custom 消息（不是 user），
       * 只有这一支才画得出来。
       */
      claimStartedMessage(event.message, session)
      break
    }
    case 'message_end': {
      const message = event.message as Parameters<OmpSession['emitUsageFrom']>[0] | undefined
      if (message !== undefined) session.emitUsageFrom(message)
      /*
       * 上下文那一格跟着每一条落地消息重报（legacy bridge.ts 在同一事件里 reportUsage）。
       * 放在样本之后：两者都是「这一条消息带来的新数」，屏幕先拿到账、再拿到占用。
       */
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
    case 'notice': {
      const level = noticeLevelOf(event.level)
      const message = String(event.message)
      const source = typeof event.source === 'string' ? event.source : undefined
      if (level === 'info') {
        /* info 是 omp 给 TUI 状态栏的（xd:// 挂载、协作者进出、慢速模式……），不是对话内容（R-09） */
        pump.logger.debug('omp notice', { source: source ?? null, message })
        break
      }
      session.requestTimeline(projector.notice(level, message, source))
      break
    }
    case 'auto_compaction_start':
      // 12 页 §9.1 的表：压缩起止各产出一条 marker（开门这条状态是 running）
      session.requestTimeline(
        projector.marker({
          markerId: `compaction-${String(projector.turnOrdinal)}`,
          marker: 'compaction',
          payload: { state: 'running', reason: event.reason },
        }),
      )
      break
    case 'auto_compaction_end':
      // 压缩后副本已不可信：让 UI 整页重取；同时把那一格标成已收口
      session.requestTimeline(
        projector.marker({
          markerId: `compaction-${String(projector.turnOrdinal)}`,
          marker: 'compaction',
          payload: {
            state: event.aborted === true ? 'cancelled' : 'completed',
            ...(typeof event.errorMessage === 'string' ? { error: event.errorMessage } : {}),
          },
        }),
      )
      if (event.aborted !== true) session.timelineReset('main')
      break
    /*
     * 自动重试（12 页 §9.1 的表）：起止各上一条 notice 帧。
     * 不接它的话，模型服务商抖动的那几十秒在屏幕上是「卡住了」——人只会看到没有输出。
     */
    case 'auto_retry_start':
      session.requestTimeline(
        projector.notice(
          'warning',
          `请求失败，第 ${String(event.attempt)}/${String(event.maxAttempts)} 次重试：${String(event.errorMessage ?? '')}`,
          'auto_retry',
        ),
      )
      break
    case 'auto_retry_end':
      if (event.success === true) {
        /* 成功只落日志：上一条 warning 后面紧跟正常回复，已经说明了结局（R-09，偏差见 refactor-log） */
        pump.logger.info('omp auto retry succeeded', { attempt: event.attempt ?? null })
        break
      }
      session.requestTimeline(projector.notice('error', `重试失败：${String(event.finalError ?? '')}`, 'auto_retry'))
      break
    default:
      break
  }
}

/**
 * 事件泵的分流与异常处理（R-02 §2.6）。
 *
 * 分类只看 `event.type` 字符串：`agent_end` 特判，工具类在失败时就地降级那一格，
 * 其余一律只记日志。这样以后新接一个 omp 事件不用改泵就已经是安全的（最坏只丢它自己的产出）。
 */
function handleOmpEvent(event: Record<string, unknown>, pump: EventPump): void {
  const eventType = typeof event.type === 'string' ? event.type : 'unknown'
  if (eventType === 'agent_end') {
    endTurn(pump)
    return
  }
  try {
    dispatchOmpEvent(event, pump)
  } catch (error) {
    const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : null
    pump.faults.report(eventType, error, toolCallId === null ? {} : { toolCallId })
    if (TOOL_EVENTS.has(eventType) && toolCallId !== null) degradeTool(eventType, event, toolCallId, pump)
  }
}

/**
 * 工具事件投影失败时就地降级这一格（R-02 §2.3）：`frame.upsert` 是同 id 整格替换，
 * 覆盖一次就重新一致；后续成功的 update / end 还会再覆盖回真实内容。
 *
 * 拿不到字符串类型的 `toolCallId` 时定位不到那一格，调用方只记日志。
 */
function degradeTool(eventType: string, event: Record<string, unknown>, toolCallId: string, pump: EventPump): void {
  const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool'
  const ended = eventType === 'tool_execution_end' ? event.isError === true : null
  try {
    pump.session.requestTimeline(pump.projector.toolFallback({ toolCallId, toolName, ended }))
  } catch (error) {
    pump.faults.report(`${eventType}.fallback`, error, { toolCallId })
  }
}

/**
 * `agent_end`：收口与上下文读数各自兜住，互不连累；最后结清这一轮的异常账。
 *
 * `finishTurn()` 自己保证收口（R-02 §2.7），所以第一个 catch 只是为了记日志。
 */
function endTurn(pump: EventPump): void {
  try {
    pump.session.finishTurn()
  } catch (error) {
    pump.faults.report('agent_end', error)
  }
  try {
    /* 轮终再报一次：收尾（压缩标记、最后一条消息之后的变动）也要落到屏幕上的读数里。 */
    pump.session.reportContextUsage()
  } catch (error) {
    pump.faults.report('agent_end.contextUsage', error)
  }
  pump.faults.settle()
}
