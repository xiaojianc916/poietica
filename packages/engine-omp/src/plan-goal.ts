import { EngineErrorCode } from '@poietica/engine'
import { AppError } from '@poietica/foundation'
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

/** 会话面上目标模式用到的那几格 */
export interface GoalCapableSession {
  getEnabledToolNames(): string[]
  hasBuiltInTool(name: string): boolean
  setActiveToolsByName(toolNames: string[]): Promise<void>
  getGoalModeState(): { goal: { status: string } } | undefined
  setGoalModeState(state: unknown): void
  readonly goalRuntime: {
    createGoal(input: { objective: string }): Promise<unknown>
    replaceGoal(input: { objective: string }): Promise<unknown>
    resumeGoal(): Promise<unknown>
    dropGoal(): Promise<unknown>
  }
  get isStreaming(): boolean
  sendGoalModeContext(options?: { deliverAs?: 'steer' | 'followUp' | 'nextTurn' | 'aside' }): Promise<void>
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
 * 设置 / 清除目标（迁移 legacy `selectGoal`）。
 *
 * 三件事缺一不可：goalRuntime 建/收目标；把 `goal` 工具塞回活动集（SDK 建会话时
 * 无条件摘掉它）；setGoalModeState。正在跑的时候还要把目标上下文 steer 进去，
 * 否则模型要等下一轮才知道目标变了。
 */
export async function applyGoal(input: {
  readonly session: GoalCapableSession
  readonly root: SettingsScope
  readonly goal: string | null
  /** 可用性读数（缺省=现读设置；测试可注入） */
  readonly availability?: AvailabilityReader
}): Promise<void> {
  requireAvailable(input.availability ?? (() => availabilityOf(input.root)), 'goal')
  const { session } = input

  if (input.goal === null) {
    await session.goalRuntime.dropGoal()
    session.setGoalModeState(undefined)
    return
  }

  const objective = input.goal.trim()
  const existing = session.getGoalModeState()
  if (!session.hasBuiltInTool('goal')) {
    throw new AppError(EngineErrorCode.goalUnavailable, '这条会话没有 goal 工具')
  }
  // 先算活动工具集再落状态（与官方 TUI 同次序）
  const previous = session.getEnabledToolNames().filter((name) => name !== 'goal')
  await session.setActiveToolsByName([...new Set([...previous, 'goal'])])

  /*
   * 三个分支：同一目标且已暂停 → **继续**（不是重建，重建会清掉进度与用量）；
   * 没有目标 → 新建；有别的目标 → 替换。
   */
  const current = goalOf(existing)
  const next =
    current?.status === 'paused' && current.objective === objective
      ? await session.goalRuntime.resumeGoal()
      : existing === undefined
        ? await session.goalRuntime.createGoal({ objective })
        : await session.goalRuntime.replaceGoal({ objective })
  session.setGoalModeState(next)

  if (session.isStreaming) await session.sendGoalModeContext({ deliverAs: 'steer' })
}

/** 会话状态里那条目标的可判据（omp 的 GoalModeState.goal） */
function goalOf(state: unknown): { readonly objective: string; readonly status: string } | undefined {
  const goal = (state as { goal?: { objective?: unknown; status?: unknown } } | undefined)?.goal
  if (typeof goal?.objective !== 'string' || typeof goal.status !== 'string') return undefined
  return { objective: goal.objective, status: goal.status }
}
