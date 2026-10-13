import { EngineErrorCode } from '@poietica/engine'
import { AppError, SystemErrorCode } from '@poietica/foundation'
import { type PlanOutcome, planApprovedText, planRejectedText, planRevisionText } from '../interactions/plan'
import type { SettingsScope } from '../settings-access'
import { readSetting } from '../settings-access'

/*
 * 模式接线：omp 按会话状态决定要不要收起工具集、要不要把 plan/goal 工具塞回活动集，这里只做接线。
 * 目标的建 / 续 / 停 / 弃走目标宿主（goal-host.ts），计划正文由适配器读好交进来。
 */

/** omp 那边「先别动手」靠摘工具实现（tools/bash.ts 自己没读计划状态），三件必须摘掉 */
const PLAN_MODE_STRIP: ReadonlySet<string> = new Set(['bash', 'eval', 'task'])

/** 计划文件的默认落点：omp 自己的约定（适配器解析计划时也用它） */
export const DEFAULT_PLAN_FILE = 'local://PLAN.md'

const PLAN_ENABLED_PATH = 'plan.enabled'
const GOAL_ENABLED_PATH = 'goal.enabled'

/** 会话面上计划模式用到的那几格 */
export interface PlanCapableSession {
  getEnabledToolNames(): string[]
  hasBuiltInTool(name: string): boolean
  setActiveToolsByName(toolNames: string[]): Promise<void>
  getPlanModeState(): { enabled: boolean; planFilePath: string; workflow?: string } | undefined
  setPlanModeState(
    state: { enabled: boolean; planFilePath: string; workflow?: string; reentry?: boolean } | undefined,
  ): void
  setPlanProposalHandler(handler: ((title: string) => Promise<unknown>) | null): void
  setPlanReferencePath(path: string): void
  get isStreaming(): boolean
  sendPlanModeContext(options?: { deliverAs?: 'steer' | 'followUp' | 'nextTurn' | 'aside' }): Promise<void>
}

/** 计划文件的路径与正文都由 omp 自己那两格（sessionManager 的 artifactsDir 与 sessionId）解出，不自己拼 */
export interface PlanArtifactSession {
  readonly sessionId: string
  /** 会话作用域那两格（artifacts 目录与工作目录）：omp 的 SessionManager 就是它 */
  readonly sessionManager: {
    getArtifactsDir(): string | null
    getSessionId(): string
    getCwd(): string
  }
}

/**
 * 目标模式那几格：`goal` 工具的去留、建目标与弃目标都归目标宿主 —— 两处各管一半就会有两份
 * 「进目标前的那一份」工具集，谁先还原谁就把对方的改动冲掉。
 */
export interface GoalCapableSession {
  hasBuiltInTool(name: string): boolean
  getPlanModeState(): { enabled: boolean } | undefined
  getGoalModeState(): { goal: { status: string } } | undefined
  setGoalModeState(state: unknown): void
  readonly goalRuntime: {
    replaceGoal(input: { objective: string }): Promise<unknown>
    resumeGoal(): Promise<unknown>
    pauseGoal(): Promise<unknown>
  }
  get isStreaming(): boolean
  sendGoalModeContext(options?: { deliverAs?: 'steer' | 'followUp' | 'nextTurn' | 'aside' }): Promise<void>
}

/** 目标宿主在这里用到的四个动作（goal-host.ts 的 GoalHost 的子集；测试可以给假的） */
export interface GoalHostActions {
  create(objective: string): Promise<void>
  resume(): Promise<void>
  pause(): Promise<void>
  drop(): Promise<void>
}

/** 两档可用性的读数：现读 agent 设置，不缓存 —— 用户在设置页改了要立刻生效 */
export type Availability = { readonly plan: boolean; readonly goal: boolean }
export type AvailabilityReader = () => Availability

export function availabilityOf(root: SettingsScope): Availability {
  return { plan: readSetting(root, PLAN_ENABLED_PATH) === true, goal: readSetting(root, GOAL_ENABLED_PATH) === true }
}

function requireAvailable(reader: AvailabilityReader, which: 'plan' | 'goal'): void {
  if (reader()[which]) return
  throw new AppError(
    which === 'plan' ? EngineErrorCode.planUnavailable : EngineErrorCode.goalUnavailable,
    which === 'plan' ? '计划模式已在 Agent 设置里关闭' : '目标模式已在 Agent 设置里关闭',
  )
}

/**
 * 进 / 出计划模式。进模式的次序是硬要求：**先落状态再改工具集** —— omp 按 `planModeEnabled()` 判
 * `write` 该不该留，次序反过来模型就写不了计划文件。
 */
export async function applyPlanMode(input: {
  readonly session: PlanCapableSession
  readonly root: SettingsScope
  readonly enabled: boolean
  readonly planTools: readonly string[] | undefined
  readonly onProposal: ((title: string) => Promise<unknown>) | null
  readonly availability?: AvailabilityReader
}): Promise<{ readonly planTools: readonly string[] | undefined }> {
  const { session } = input
  requireAvailable(input.availability ?? (() => availabilityOf(input.root)), 'plan')

  if (!input.enabled) {
    // 退出：处理器先摘，状态再清，最后按进模式前记下的那份还原工具集
    session.setPlanProposalHandler(null)
    session.setPlanModeState(undefined)
    if (input.planTools !== undefined) await session.setActiveToolsByName([...input.planTools])
    return { planTools: undefined }
  }

  const active = session.getEnabledToolNames()
  // 重复进入时保留第一次记下的那份（reentry 的情形）
  const planTools = input.planTools ?? active
  const state = session.getPlanModeState()
  session.setPlanModeState({
    enabled: true,
    planFilePath: state?.planFilePath ?? DEFAULT_PLAN_FILE,
    workflow: state?.workflow ?? 'parallel',
    reentry: state !== undefined,
  })
  const readonly = active.filter((name) => !PLAN_MODE_STRIP.has(name))
  await session.setActiveToolsByName(session.hasBuiltInTool('write') ? [...new Set([...readonly, 'write'])] : readonly)
  session.setPlanProposalHandler(input.onProposal)
  if (session.isStreaming) await session.sendPlanModeContext({ deliverAs: 'steer' })
  return { planTools }
}

/** 一次计划提交在 omp 侧的详情（就是 omp 的 PlanApprovalDetails：路径、标题、文件在不在） */
export interface PlanProposalDetails {
  readonly planFilePath: string
  readonly title: string
  readonly planExists: boolean
}

export interface PlanProposalHandled {
  readonly result: {
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
    readonly details: unknown
  }
  /** 批准之后要退出计划模式（调用方负责还原工具集与补一次 controls） */
  readonly approved: boolean
  /** 这一版计划要求修改时的反馈（revise 用） */
  readonly feedback: string | null
  readonly markdown: string | null
}

/**
 * 四档结局：approve 登记参考路径 → 退模式 → 交回「按它执行」；revise **留在计划模式里**把意见交回、
 * 路径变了写回状态；reject / dismiss 也留在计划模式里，交回「不要执行，也不要重新提交」。
 */
export async function settlePlanProposal(input: {
  readonly session: PlanCapableSession
  readonly details: PlanProposalDetails
  readonly markdown: string | null
  readonly outcome: PlanOutcome
}): Promise<PlanProposalHandled> {
  const { details, markdown } = input
  const text = (body: string): PlanProposalHandled => ({
    result: { content: [{ type: 'text' as const, text: body }], details },
    approved: false,
    feedback: input.outcome.feedback,
    markdown,
  })

  /** revise / reject / dismiss：都留在计划模式里，只把人的话回给模型 */
  if (input.outcome.decision === 'revise') {
    const feedback = input.outcome.feedback ?? ''
    /** 路径变了就写回计划状态：agent 换一个 slug 重写计划文件之后，状态里那条仍指着上一版 */
    const state = input.session.getPlanModeState()
    if (state !== undefined && state.planFilePath !== details.planFilePath) {
      input.session.setPlanModeState({ ...state, planFilePath: details.planFilePath })
    }
    return { ...text(planRevisionText(details.planFilePath, feedback)), feedback }
  }
  if (input.outcome.decision === 'reject') return text(planRejectedText(details.planFilePath))

  /** approve：登记参考路径 → 处理器置 null → 状态清掉；工具集还原由调用方做完这几步之后执行 */
  input.session.setPlanReferencePath(details.planFilePath)
  input.session.setPlanProposalHandler(null)
  input.session.setPlanModeState(undefined)
  return {
    result: {
      content: [{ type: 'text' as const, text: planApprovedText(details.planFilePath) }],
      details,
    },
    approved: true,
    feedback: null,
    markdown,
  }
}

/**
 * 建与弃交给目标宿主（`goal` 工具的去留、完成 / 放弃之后的收尾、两轮之间的续跑）。设置一支按现状
 * 分四种：没有目标或上一个已完成 → host.create；正文没变 → 什么都不做（重建会清掉进度与用量）；
 * 已暂停、正文变了 → 换正文仍是暂停；进行中或受阻、正文变了 → replaceGoal 并把新目标 steer 进去。
 * 清除不查可用性：设置里关掉目标模式之后，人仍然要能把挂着的目标收掉。
 */
export async function applyGoal(input: {
  readonly session: GoalCapableSession
  readonly host: GoalHostActions
  readonly root: SettingsScope
  readonly goal: string | null
  readonly availability?: AvailabilityReader
}): Promise<void> {
  const { session, host } = input

  if (input.goal === null) {
    await host.drop()
    return
  }

  requireCanEnter(input, '先退出计划模式，再设定目标')
  const objective = input.goal.trim()
  const current = goalOf(session.getGoalModeState())

  if (current === undefined || current.status === 'complete' || current.status === 'dropped') {
    /** 上一个目标完成了却还挂在会话状态里：先清掉 —— 控制器见到 enabled 的残留会拒绝新建 */
    if (current !== undefined) session.setGoalModeState(undefined)
    await host.create(objective)
    return
  }
  if (current.objective === objective) return
  if (current.status === 'paused') {
    await replacePausedGoal(session, objective)
    return
  }
  session.setGoalModeState(await session.goalRuntime.replaceGoal({ objective }))
  if (session.isStreaming) await session.sendGoalModeContext({ deliverAs: 'steer' })
}

/**
 * 暂停目标：**不打断这一轮**，只停之后 —— 不再计用量、不再续跑、不再注入目标上下文，`goal` 工具由
 * 宿主摘掉。已暂停时不做事；不查可用性（设置里关掉目标模式之后，人仍要能停下挂着的目标）。
 */
export async function pauseGoalMode(input: {
  readonly session: GoalCapableSession
  readonly host: GoalHostActions
}): Promise<void> {
  const status = goalOf(input.session.getGoalModeState())?.status
  if (status === 'paused') return
  if (!isRunning(status)) throw new AppError(SystemErrorCode.notFound, '这条对话没有进行中的目标')
  await input.host.pause()
}

/** 继续已暂停的目标：`goal` 工具加回活动集、状态回到进行中；正在跑就把上下文 steer 进去，空闲时宿主立刻续跑 */
export async function resumeGoalMode(input: {
  readonly session: GoalCapableSession
  readonly host: GoalHostActions
  readonly root: SettingsScope
  readonly availability?: AvailabilityReader
}): Promise<void> {
  const status = goalOf(input.session.getGoalModeState())?.status
  if (isRunning(status)) return
  if (status !== 'paused') throw new AppError(SystemErrorCode.notFound, '这条对话没有已暂停的目标')
  requireCanEnter(input, '先退出计划模式，再继续目标')
  await input.host.resume()
}

/**
 * 建 / 续目标之前的三道闸：设置里开着、会话有 goal 工具、不在计划模式里。宿主自己也查第一道和第三道，
 * 但报的是英文原话；在这里先查，人看到的才是中文。
 */
function requireCanEnter(
  input: {
    readonly session: GoalCapableSession
    readonly root: SettingsScope
    readonly availability?: AvailabilityReader
  },
  planModeMessage: string,
): void {
  requireAvailable(input.availability ?? (() => availabilityOf(input.root)), 'goal')
  if (!input.session.hasBuiltInTool('goal')) {
    throw new AppError(EngineErrorCode.goalUnavailable, '这条会话没有 goal 工具')
  }
  if (input.session.getPlanModeState()?.enabled === true) throw new AppError(SystemErrorCode.conflict, planModeMessage)
}

/**
 * 换掉一个**已暂停**目标的正文，换完仍是暂停。omp 的 replaceGoal 只认进行中的目标，所以走它自己的
 * 三步 resume → replace → pause（replace 失败也要停回暂停，再把原错抛出去）；中间两次 goal_updated
 * 由 OmpSession 的控件批处理吞掉。直接调 runtime、**不经目标宿主**：宿主的 resume 会当成「人按了继续」
 * 而在空闲时排一轮续跑，goal 工具也不动。
 */
async function replacePausedGoal(session: GoalCapableSession, objective: string): Promise<void> {
  await session.goalRuntime.resumeGoal()
  try {
    await session.goalRuntime.replaceGoal({ objective })
  } finally {
    session.setGoalModeState(await session.goalRuntime.pauseGoal())
  }
}

/** omp 计用量的那两档（runtime 的 isAccountingStatus）：受阻（budget-limited）也算在跑 */
function isRunning(status: string | undefined): boolean {
  return status === 'active' || status === 'budget-limited'
}

function goalOf(state: unknown): { readonly objective: string; readonly status: string } | undefined {
  const goal = (state as { goal?: { objective?: unknown; status?: unknown } } | undefined)?.goal
  if (typeof goal?.objective !== 'string' || typeof goal.status !== 'string') return undefined
  return { objective: goal.objective, status: goal.status }
}
