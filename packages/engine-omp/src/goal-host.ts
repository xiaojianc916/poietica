import {
  RPC_GOAL_CONTINUATION_MODE,
  RpcGoalController,
  type RpcGoalSession,
} from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal'
import type { AgentSessionEvent } from '@oh-my-pi/pi-coding-agent/session/agent-session'
import type { Logger } from '@poietica/foundation'
import { GOAL_CONTINUATION_TYPE } from './prompt'
import { overrideSetting, readSetting, type SettingsScope } from './settings-access'

/*
 * 目标模式的宿主职责（审查 R-11）。
 *
 * omp 把目标的「持久生命周期」（建 / 续 / 停 / 弃、计量、落盘）放在 GoalRuntime 里，三个宿主共用；
 * 而「宿主职责」——goal 工具在活动集里的去留、完成 / 放弃之后的收尾、重开会话时把目标接回来、
 * 两轮之间自动续跑——TUI 写在 InteractiveMode 里，RPC 宿主写在 RpcGoalController 里。
 * Poietica 是第四个宿主，先前一件都没做。
 *
 * 这里**不自己实现**这些判断，直接用 omp 导出的 RpcGoalController（与 `omp --mode rpc` 同一份代码），
 * 只在两处接线：
 *   1. 续跑那一轮要变成 Poietica 的一轮（状态 running、时间线开一轮）——拦它交给会话的
 *      promptCustomMessage，先问 OmpSession 能不能开（reserveContinuation）；
 *   2. 目标是随一句话一起建的（输入框「目标」开关 + 发送）——建好之后第一轮必须是人的那一句，
 *      不能让控制器抢先开一轮续跑（awaitingFirstTurn）。
 */

const CONTINUATION_MODES_PATH = 'goal.continuationModes'
const INTERACTIVE_CONTINUATION_MODE = 'interactive'

/** OmpSession 这一边要接住的三件事 */
export interface GoalTurnHooks {
  /** 控制器要开一次续跑了。返回 false = 让位（Poietica 自己有一轮正在起步、或会话已关） */
  reserveContinuation(): boolean
  /** 预留的续跑没有开出来（omp 没收下，或半路抛错）：放掉预留。error 为 null 表示只是没收下 */
  releaseContinuation(error: unknown): void
  /** 控制器放弃了一次待开的续跑（等待期间某道闸关上了）：会话按需收成 idle */
  continuationDropped(): void
}

export interface GoalHost {
  /** 每一条 omp 事件都先过它（必须先于 OmpSession 自己的收尾，见 handleOmpEvent） */
  observe(event: Record<string, unknown>): void
  /** 有一次续跑已经决定、还没开出来：此刻会话不能报 idle */
  continuationPending(): boolean
  /** 人按了停止：必须在 abort 之前调，被中断那一轮自己的 agent_end 才不会再排一次续跑 */
  stopForHostAbort(): void
  /** 打开会话时接回会话文件里记着的目标；进行中的一律以「已暂停」接回 */
  reconcile(): Promise<void>
  create(objective: string): Promise<void>
  resume(): Promise<void>
  pause(): Promise<void>
  drop(): Promise<void>
}

/**
 * Poietica 是交互式宿主：用户的 `goal.continuationModes` 里有 `interactive`（omp 默认就有）时，
 * 给**本会话**加上 `rpc` 这一档 —— 控制器只认 `rpc`。只写本会话的 override 层，不落盘、不串会话。
 * 用户把 `interactive` 去掉了（明确不要自动续跑），就尊重它，不加。
 */
export function allowGoalContinuation(scope: SettingsScope): void {
  const current = readSetting(scope, CONTINUATION_MODES_PATH)
  const modes = Array.isArray(current) ? current.filter((mode): mode is string => typeof mode === 'string') : []
  if (!modes.includes(INTERACTIVE_CONTINUATION_MODE) || modes.includes(RPC_GOAL_CONTINUATION_MODE)) return
  overrideSetting(scope, CONTINUATION_MODES_PATH, [...modes, RPC_GOAL_CONTINUATION_MODE])
}

export function createGoalHost(input: {
  /** omp 的 AgentSession（控制器要的那十几格它都有） */
  readonly session: RpcGoalSession
  readonly hooks: GoalTurnHooks
  readonly logger: Logger
}): GoalHost {
  const { session, hooks, logger } = input
  /** 刚由 Poietica 建好、还没跑过一轮：续跑一律让位给人的那一句 */
  let awaitingFirstTurn = false

  const prompt: RpcGoalSession['promptCustomMessage'] = async (message, options) => {
    if (message.customType !== GOAL_CONTINUATION_TYPE) return await session.promptCustomMessage(message, options)
    if (awaitingFirstTurn || !hooks.reserveContinuation()) return false
    try {
      const dispatched = await session.promptCustomMessage(message, options)
      if (!dispatched) hooks.releaseContinuation(null)
      return dispatched
    } catch (error) {
      hooks.releaseContinuation(error)
      throw error
    }
  }

  const controller = new RpcGoalController(controllerSessionOf(session, prompt), () => {
    hooks.continuationDropped()
  })

  return {
    observe(event) {
      controller.observe(event as unknown as AgentSessionEvent)
      if (event.type === 'agent_end' && event.isTerminal !== false) awaitingFirstTurn = false
    },
    continuationPending: () => controller.continuationPending,
    stopForHostAbort: () => controller.stopForHostAbort(),
    async reconcile() {
      try {
        await controller.reconcile()
      } catch (error) {
        // 接不回来只是没有目标：不能因此打不开这条对话
        logger.warn('goal reconcile failed', { error: error instanceof Error ? error.message : String(error) })
      }
    },
    async create(objective) {
      await controller.handle({ op: 'create', objective })
      awaitingFirstTurn = true
    },
    async resume() {
      awaitingFirstTurn = false
      await controller.handle({ op: 'resume' })
    },
    async pause() {
      awaitingFirstTurn = false
      await controller.handle({ op: 'pause' })
    },
    async drop() {
      awaitingFirstTurn = false
      await controller.handle({ op: 'drop' })
    },
  }
}

/**
 * 交给控制器的会话：除 promptCustomMessage 之外一律**现读现调真会话**。
 *
 * 不能把值拷出来（isStreaming 这几格是 getter，拷一次就永远是那一刻的值），也不能把方法从
 * 会话上摘下来裸调（omp 的类方法读私有字段 `this.#…`，丢了接收者当场抛错）。
 */
function controllerSessionOf(session: RpcGoalSession, prompt: RpcGoalSession['promptCustomMessage']): RpcGoalSession {
  return {
    get settings() {
      return session.settings
    },
    get sessionManager() {
      return session.sessionManager
    },
    get goalRuntime() {
      return session.goalRuntime
    },
    getGoalModeState: () => session.getGoalModeState(),
    setGoalModeState: (state) => session.setGoalModeState(state),
    getPlanModeState: () => session.getPlanModeState(),
    getEnabledToolNames: () => session.getEnabledToolNames(),
    setActiveToolsByName: async (names) => await session.setActiveToolsByName(names),
    sendGoalModeContext: async (options) => await session.sendGoalModeContext(options),
    getTodoPhases: () => session.getTodoPhases(),
    promptCustomMessage: prompt,
    waitForIdle: async () => await session.waitForIdle(),
    get isStreaming() {
      return session.isStreaming
    },
    get isDisposed() {
      return session.isDisposed
    },
    get isSessionTransitioning() {
      return session.isSessionTransitioning
    },
    get hasAdmittedSubmission() {
      return session.hasAdmittedSubmission
    },
    get queuedMessageCount() {
      return session.queuedMessageCount
    },
  }
}
