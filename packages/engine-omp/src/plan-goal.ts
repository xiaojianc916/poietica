import { EngineErrorCode } from '@poietica/engine'
import { AppError, SystemErrorCode } from '@poietica/foundation'
import { type PlanOutcome, planApprovedText, planRejectedText, planRevisionText } from './interactions/plan'
import type { SettingsScope } from './settings-access'
import { readSetting } from './settings-access'

/*
 * 计划模式与目标模式的接线（04 §2.4 / §3.11、12 §7.7 / §8.5）。
 *
 * 两个模式都不是「本地记一格」就算数的：omp 按会话状态决定要不要收起工具集、要不要
 * 把 plan/goal 的工具塞回活动集，并把模式上下文注入对话。这里只做接线，判断留在 omp。
 *
 * 会话面上用到的那几格（照 dist/types/session/agent-session.d.ts 的签名收窄）：
 * getEnabledToolNames / hasBuiltInTool / setActiveToolsByName / getPlanModeState /
 * setPlanModeState / setPlanProposalHandler / setPlanReferencePath / getGoalModeState /
 * setGoalModeState / goalRuntime / isStreaming / sendPlanModeContext / sendGoalModeContext。
 * 目标的建 / 续 / 停 / 弃走目标宿主（goal-host.ts，审查 R-11），这里只做预检与换正文。
 *
 * 计划正文不在这里读：解析计划文件要 omp 的模块（resolveApprovedPlan / readPlanFile），
 * 适配器读好之后把 { 路径, 标题, 正文 } 交进来 —— 见 omp-session-adapter 的 resolvePlanProposal。
 */

/** omp 那边「先别动手」靠摘工具实现（tools/bash.ts 自己没读计划状态），三件必须摘掉 */
const PLAN_MODE_STRIP: ReadonlySet<string> = new Set(['bash', 'eval', 'task'])

/** 计划文件的默认落点：omp 自己的约定，与 legacy 逐字相同（适配器解析计划时也用它） */
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

/**
 * 会话作用域的 `local://` 落点：计划文件的路径与正文都由它解出。
 *
 * 就是 omp 自己那两格（sessionManager 的 artifactsDir 与 sessionId，见 agent-session 的
 * #localProtocolOptions）：自己拼一条路径就是第二份真身，换会话、改布局都会错位。
 */
export interface PlanArtifactSession {
  /** agent 会话自己签的号：`local://` 落点按会话分家 */
  readonly sessionId: string
  /** 会话作用域那两格（artifacts 目录与工作目录）：omp 的 SessionManager 就是它 */
  readonly sessionManager: {
    getArtifactsDir(): string | null
    getSessionId(): string
    getCwd(): string
  }
}

/**
 * 会话面上目标模式用到的那几格（审查 R-11 收窄）。
 *
 * 不再有 getEnabledToolNames / setActiveToolsByName / createGoal / dropGoal：`goal` 工具在活动集里的
 * 去留、建目标与弃目标都归目标宿主（goal-host.ts 背后的 omp RpcGoalController）—— 两处各管一半，
 * 工具集就会有两份「进目标前的那一份」，谁先还原谁就把对方的改动冲掉。
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

/**
 * 两档可用性的**读数**：现读 agent 设置（不缓存 —— 用户在设置页改了要立刻生效）。
 *
 * 功能测试传假的读数即可（`plan-goal.test.ts` 就是这么测的两条「不可用」路径），
 * 生产路径不传，走 `readSetting`。
 */
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
 * 进/出计划模式（迁移 legacy `selectPlan`）。返回是否**真的**改变了状态。
 *
 * 进模式的次序是硬要求：**先落状态再改工具集** —— omp 按 `planModeEnabled()` 判 `write`
 * 该不该留，次序反过来 `write` 会在计算工具集时不被认成计划模式要用，模型就写不了计划文件。
 */
export async function applyPlanMode(input: {
  readonly session: PlanCapableSession
  readonly root: SettingsScope
  readonly enabled: boolean
  readonly planTools: readonly string[] | undefined
  readonly onProposal: ((title: string) => Promise<unknown>) | null
  /** 可用性读数（缺省=现读设置；测试可注入） */
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
  /** 交给 provider 的工具结果：content + details，与 omp 的 AgentToolResult 同形 */
  readonly result: {
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
    readonly details: unknown
  }
  /** 批准之后要退出计划模式（调用方负责还原工具集与补一次 controls） */
  readonly approved: boolean
  /** 这一版计划要求修改时的反馈（revise 用） */
  readonly feedback: string | null
  /** 计划正文（读不到就是 null） */
  readonly markdown: string | null
}

/**
 * 一次计划提交的四档结局（产品负责人 2026-10-07 定稿的表）。
 *
 * approve：登记参考路径 → 退模式 → 还原工具集（由调用方做）→ 交回「按它执行」；
 * revise：**留在计划模式里**，把人的意见原样交回；路径变了就写回状态；
 * reject / dismiss：同样留在计划模式里，交回「不要执行，也不要重新提交」。
 *
 * 正文由调用方读好交进来（readPlanFile 要 omp 的模块，不在这一层）：卡片要画它，autosave
 * 也要它，读一次两处都用。
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

  /* revise / reject / dismiss：都留在计划模式里，只把人的话回给模型 */
  if (input.outcome.decision === 'revise') {
    const feedback = input.outcome.feedback ?? ''
    /*
     * 路径变了就写回计划状态：agent 换一个 slug 重写计划文件之后，状态里那条仍指着上一版 ——
     * 下一次提交、以及批准时登记的参考路径，都会落到一份旧文件上。
     */
    const state = input.session.getPlanModeState()
    if (state !== undefined && state.planFilePath !== details.planFilePath) {
      input.session.setPlanModeState({ ...state, planFilePath: details.planFilePath })
    }
    return { ...text(planRevisionText(details.planFilePath, feedback)), feedback }
  }
  if (input.outcome.decision === 'reject') return text(planRejectedText(details.planFilePath))

  /*
   * approve：登记参考路径 → 处理器置 null → 状态清掉。
   * 工具集的还原由调用方在做完这几步之后执行（它拿着进模式时记下的那一份）。
   */
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
 * 设置 / 清除目标（迁移 legacy `selectGoal`；R-10 改成「只改正文、不改状态」；R-11 改走目标宿主）。
 *
 * 建与弃交给目标宿主（host）：它负责 `goal` 工具的去留、完成 / 放弃之后的收尾和两轮之间的续跑。
 * 设置一支按现状分四种：
 *   没有目标 / 上一个已完成 → host.create（omp 只在这两种情况下允许 create）；
 *   正文没变               → 什么都不做（重建会清掉进度与用量）；
 *   已暂停、正文变了       → 换正文，仍是暂停（replacePausedGoal）；
 *   进行中 / 受阻、正文变了 → replaceGoal；正在跑的时候把新目标 steer 进去。
 *
 * 清除不查可用性：设置里关掉目标模式之后，人仍然要能把挂着的目标收掉。
 */
export async function applyGoal(input: {
  readonly session: GoalCapableSession
  readonly host: GoalHostActions
  readonly root: SettingsScope
  readonly goal: string | null
  /** 可用性读数（缺省=现读设置；测试可注入） */
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
    /*
     * 上一个目标完成了却还挂在会话状态里（R-11 之前的会话文件没有收尾记录，接回来就是这样一格；
     * 这一轮刚完成、还没跑到收尾也是）：先清掉 —— 控制器见到 enabled 的残留会拒绝新建。
     */
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
 * 暂停目标（R-10；R-11 改走目标宿主）：**不打断这一轮**，只停之后 —— 不再计用量、不再续跑、
 * 不再给之后的提示词注入目标上下文，`goal` 工具由宿主从活动集摘掉。
 *
 * 已暂停时什么都不做；不查可用性（设置里关掉目标模式之后，人仍然要能停下挂着的目标）。
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

/**
 * 继续已暂停的目标（R-10；R-11 改走目标宿主）：`goal` 工具加回活动集、状态回到进行中；
 * 正在跑的时候把目标上下文 steer 进去，空闲时宿主会立刻续跑一轮。已在进行中（或受阻）时什么都不做。
 */
export async function resumeGoalMode(input: {
  readonly session: GoalCapableSession
  readonly host: GoalHostActions
  readonly root: SettingsScope
  /** 可用性读数（缺省=现读设置；测试可注入） */
  readonly availability?: AvailabilityReader
}): Promise<void> {
  const status = goalOf(input.session.getGoalModeState())?.status
  if (isRunning(status)) return
  if (status !== 'paused') throw new AppError(SystemErrorCode.notFound, '这条对话没有已暂停的目标')
  requireCanEnter(input, '先退出计划模式，再继续目标')
  await input.host.resume()
}

/**
 * 建 / 续目标之前的三道闸（R-11）：设置里开着、会话有 goal 工具、不在计划模式里。
 *
 * 宿主（omp 的 RpcGoalController）自己也查第一道和第三道，但报的是英文原话；
 * 在这里先查，人看到的才是中文。
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
 * 换掉一个**已暂停**目标的正文，换完仍是暂停（R-10）。
 *
 * omp 的 replaceGoal 只认进行中的目标（暂停的会抛 cannot replace goal because no goal is active），
 * 所以走 omp 自己的三步：resume → replace → pause。replace 失败也要停回暂停，再把原错抛出去。
 * 中间两次 goal_updated 由 OmpSession 的控件批处理吞掉（session.ts 的 goalBatch），屏幕上不闪「进行中」。
 *
 * 直接调 runtime、**不经目标宿主**（R-11）：宿主的 resume 会把这当成「人按了继续」，空闲时当场排一轮续跑。
 * goal 工具也不动：宿主只在它自己的 resume / pause 里改工具集，这三步不经过它。
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

/** 会话状态里那条目标的可判据（omp 的 GoalModeState.goal） */
function goalOf(state: unknown): { readonly objective: string; readonly status: string } | undefined {
  const goal = (state as { goal?: { objective?: unknown; status?: unknown } } | undefined)?.goal
  if (typeof goal?.objective !== 'string' || typeof goal.status !== 'string') return undefined
  return { objective: goal.objective, status: goal.status }
}
