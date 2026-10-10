import { describe, expect, test } from 'bun:test'
import { EngineErrorCode } from '@poietica/engine'
import type { AppError } from '@poietica/foundation'
import { planApprovedText, planRejectedText, planRevisionText } from '../interactions/plan'
import {
  applyGoal,
  applyPlanMode,
  type GoalCapableSession,
  type PlanCapableSession,
  settlePlanProposal,
} from '../plan-goal'
import type { SettingsScope } from '../settings-access'

/*
 * 计划模式与目标模式的接线（04 §2.4 / §3.11、12 §7.7 / §8.5；
 * 产品负责人 2026-10-07 定稿的四档答复与四条目标路径）。
 *
 * 被测对象是 `plan-goal.ts` 那两个纯接线函数：会话用手工搭的假对象，
 * 不起进程、不碰磁盘。判据是「往上调了哪几个方法、顺序对不对、交回去什么」。
 */

/**
 * 可用性的假读数：这两档的**取值**本身是 omp 的设置（真值由 `ports/__tests__/settings*`
 * 与一致性套件覆盖），这一份只负责「关掉时抛哪个码」这一段判断。
 */
function availabilityOf(plan: boolean, goal: boolean): () => { plan: boolean; goal: boolean } {
  return () => ({ plan, goal })
}

/** 这两个函数在可用性通过后不再读设置，所以根可以是空壳 —— 不传根就不碰 omp 注册表 */
const ROOT = undefined as unknown as SettingsScope

interface PlanHarness {
  readonly session: PlanCapableSession
  readonly calls: string[]
  readonly tools: string[]
  planState: { enabled: boolean; planFilePath: string; workflow?: string } | undefined
  readonly referencePaths: string[]
  proposalHandler: ((title: string) => Promise<unknown>) | null
  streaming: boolean
}

function planHarness(active: readonly string[] = ['read', 'write', 'bash', 'eval', 'task', 'goal']): PlanHarness {
  const calls: string[] = []
  const h: PlanHarness = {
    calls,
    tools: [...active],
    planState: undefined,
    referencePaths: [],
    proposalHandler: null,
    streaming: false,
    session: undefined as never,
  }
  const session: PlanCapableSession = {
    getEnabledToolNames: () => [...h.tools],
    hasBuiltInTool: (name) => name === 'write',
    setActiveToolsByName: async (names) => {
      calls.push(`setActiveTools:${names.join(',')}`)
      h.tools.length = 0
      h.tools.push(...names)
    },
    getPlanModeState: () => h.planState,
    setPlanModeState: (state) => {
      calls.push(`setPlanModeState:${state === undefined ? 'off' : 'on'}`)
      h.planState = state
    },
    setPlanProposalHandler: (handler) => {
      calls.push(`setPlanProposalHandler:${handler === null ? 'null' : 'fn'}`)
      h.proposalHandler = handler
    },
    setPlanReferencePath: (path) => {
      calls.push(`setPlanReferencePath:${path}`)
      h.referencePaths.push(path)
    },
    get isStreaming() {
      return h.streaming
    },
    sendPlanModeContext: async () => {
      calls.push('sendPlanModeContext')
    },
  }
  return Object.assign(h, { session })
}

describe('计划模式：进 / 出与工具集', () => {
  test('进模式先落状态再改工具集；只读组 + write，bash/eval/task 被摘掉', async () => {
    const h = planHarness()
    const next = await applyPlanMode({
      session: h.session,
      root: ROOT,
      availability: availabilityOf(true, true),
      enabled: true,
      planTools: undefined,
      onProposal: async () => 'proposal',
    })
    // 次序是硬要求：状态先落，工具集后改
    expect(h.calls[0]).toBe('setPlanModeState:on')
    expect(h.calls.indexOf('setPlanModeState:on')).toBeLessThan(
      h.calls.findIndex((c) => c.startsWith('setActiveTools')),
    )
    // 只读组 + write；三个「先别动手」的工具一个不留
    expect(h.tools).toContain('read')
    expect(h.tools).toContain('write')
    expect(h.tools).not.toContain('bash')
    expect(h.tools).not.toContain('eval')
    expect(h.tools).not.toContain('task')
    // 处理器装上、进模式前那份工具集被记下
    expect(h.proposalHandler).not.toBeNull()
    expect(next.planTools).toEqual(['read', 'write', 'bash', 'eval', 'task', 'goal'])
  })

  test('退出模式：处理器置 null、状态清掉、工具集原样还原', async () => {
    const h = planHarness()
    const entered = await applyPlanMode({
      session: h.session,
      root: ROOT,
      availability: availabilityOf(true, true),
      enabled: true,
      planTools: undefined,
      onProposal: async () => 'proposal',
    })
    h.calls.length = 0

    const left = await applyPlanMode({
      session: h.session,
      root: ROOT,
      availability: availabilityOf(true, true),
      enabled: false,
      planTools: entered.planTools,
      onProposal: null,
    })
    expect(h.calls).toEqual([
      'setPlanProposalHandler:null',
      'setPlanModeState:off',
      'setActiveTools:read,write,bash,eval,task,goal',
    ])
    expect(h.tools).toEqual(['read', 'write', 'bash', 'eval', 'task', 'goal'])
    expect(left.planTools).toBeUndefined()
  })

  test('正在流式输出时进模式要把模式上下文 steer 进去', async () => {
    const h = planHarness()
    h.streaming = true
    await applyPlanMode({
      session: h.session,
      root: ROOT,
      availability: availabilityOf(true, true),
      enabled: true,
      planTools: undefined,
      onProposal: async () => 'proposal',
    })
    expect(h.calls).toContain('sendPlanModeContext')
  })

  test('设置里关掉计划模式时进模式抛 engine.plan_unavailable', async () => {
    const h = planHarness()
    const error = await applyPlanMode({
      session: h.session,
      root: ROOT,
      availability: availabilityOf(false, true),
      enabled: true,
      planTools: undefined,
      onProposal: async () => 'proposal',
    }).catch((e: unknown) => e)
    expect((error as AppError).code).toBe(EngineErrorCode.planUnavailable)
    // 拒绝得干净：一个状态都没动
    expect(h.calls).toEqual([])
  })
})

describe('计划提交：四档答复', () => {
  const details = { planFilePath: 'local://x-plan.md', title: '重构输入层', planExists: true }

  test('approve：登记参考路径、退模式，交回「计划已确认」', async () => {
    const h = planHarness()
    const handled = await settlePlanProposal({
      session: h.session,
      details,
      markdown: '# 计划正文',
      outcome: { decision: 'approve', feedback: null },
    })
    expect(handled.approved).toBe(true)
    expect(h.referencePaths).toEqual(['local://x-plan.md'])
    expect(h.planState).toBeUndefined()
    expect(h.proposalHandler).toBeNull()
    expect(textOf(handled.result)).toBe(planApprovedText('local://x-plan.md'))
    expect(handled.markdown).toBe('# 计划正文')
  })

  test('revise：留在计划模式，交回人的意见（带路径）', async () => {
    const h = planHarness()
    h.planState = { enabled: true, planFilePath: 'local://x-plan.md' }
    const handled = await settlePlanProposal({
      session: h.session,
      details,
      markdown: '# 计划正文',
      outcome: { decision: 'revise', feedback: '补上回滚方案' },
    })
    expect(handled.approved).toBe(false)
    expect(textOf(handled.result)).toBe(planRevisionText('local://x-plan.md', '补上回滚方案'))
    // 留在计划模式里：出模式等于告诉模型可以动手了
    expect(h.planState?.enabled).toBe(true)
    expect(h.referencePaths).toEqual([])
  })

  test('revise 换了计划文件：把新路径写回计划状态（下一次提交才指着同一份）', async () => {
    const h = planHarness()
    h.planState = { enabled: true, planFilePath: 'local://旧-plan.md', workflow: 'parallel' }
    await settlePlanProposal({
      session: h.session,
      details,
      markdown: '# 计划正文',
      outcome: { decision: 'revise', feedback: '补上回滚方案' },
    })
    // 模式没退，只有路径换了 —— workflow 这些格原样留着
    expect(h.planState).toEqual({
      enabled: true,
      planFilePath: 'local://x-plan.md',
      workflow: 'parallel',
    })
  })

  test('reject：留在计划模式，交回「不要执行，也不要重新提交」', async () => {
    const h = planHarness()
    h.planState = { enabled: true, planFilePath: 'local://x-plan.md' }
    const handled = await settlePlanProposal({
      session: h.session,
      details,
      markdown: null,
      outcome: { decision: 'reject', feedback: null },
    })
    expect(handled.approved).toBe(false)
    expect(textOf(handled.result)).toBe(planRejectedText('local://x-plan.md'))
    expect(h.planState?.enabled).toBe(true)
  })

  test('dismiss（超时 / 中止 / 取消）与 reject 同效：留在计划模式', async () => {
    const h = planHarness()
    h.planState = { enabled: true, planFilePath: 'local://x-plan.md' }
    const handled = await settlePlanProposal({
      session: h.session,
      details,
      markdown: null,
      outcome: { decision: 'reject', feedback: null },
    })
    expect(handled.approved).toBe(false)
    expect(h.planState?.enabled).toBe(true)
    expect(h.calls).toEqual([])
  })

  test('计划正文读不到时如实为空串，不让这次提交失败', async () => {
    const h = planHarness()
    const handled = await settlePlanProposal({
      session: h.session,
      details,
      markdown: null,
      outcome: { decision: 'approve', feedback: null },
    })
    expect(handled.markdown).toBeNull()
    expect(handled.approved).toBe(true)
  })
})

interface GoalHarness {
  readonly session: GoalCapableSession
  readonly calls: string[]
  goalState: unknown
  readonly tools: string[]
  streaming: boolean
}

function goalHarness(): GoalHarness {
  const calls: string[] = []
  const h: GoalHarness = {
    calls,
    goalState: undefined,
    tools: ['read', 'write'],
    streaming: false,
    session: undefined as never,
  }
  const session: GoalCapableSession = {
    getEnabledToolNames: () => [...h.tools],
    hasBuiltInTool: (name) => name === 'goal',
    setActiveToolsByName: async (names) => {
      h.tools.length = 0
      h.tools.push(...names)
    },
    getGoalModeState: () => h.goalState as never,
    setGoalModeState: (state) => {
      h.goalState = state
    },
    goalRuntime: {
      createGoal: async ({ objective }) => {
        calls.push(`create:${objective}`)
        return { goal: { objective, status: 'active' } }
      },
      replaceGoal: async ({ objective }) => {
        calls.push(`replace:${objective}`)
        return { goal: { objective, status: 'active' } }
      },
      resumeGoal: async () => {
        calls.push('resume')
        return { goal: { objective: '旧目标', status: 'active' } }
      },
      pauseGoal: async () => {
        calls.push('pause')
        return { goal: { objective: '旧目标', status: 'paused' } }
      },
      dropGoal: async () => {
        calls.push('drop')
        return undefined
      },
    },
    get isStreaming() {
      return h.streaming
    },
    sendGoalModeContext: async () => {
      calls.push('sendGoalModeContext')
    },
  }
  return Object.assign(h, { session })
}

describe('目标模式：设置 / 清除 + 不可用（R-10：设置只改正文，不改状态）', () => {
  test('新建：把 goal 工具塞回活动集，再落状态', async () => {
    const h = goalHarness()
    await applyGoal({ session: h.session, root: ROOT, availability: availabilityOf(true, true), goal: '把测试迁完' })
    expect(h.calls).toEqual(['create:把测试迁完'])
    expect(h.tools).toContain('goal')
    expect(h.goalState).toMatchObject({ goal: { objective: '把测试迁完', status: 'active' } })
  })

  test('替换：已有别的目标时走 replaceGoal', async () => {
    const h = goalHarness()
    h.goalState = { goal: { objective: '旧目标', status: 'active' } }
    await applyGoal({ session: h.session, root: ROOT, availability: availabilityOf(true, true), goal: '新目标' })
    expect(h.calls).toEqual(['replace:新目标'])
    expect(h.goalState).toMatchObject({ goal: { objective: '新目标' } })
  })

  /*
   * R-10：设置只改正文、不改状态。以前同正文落在暂停的目标上会被当成「继续」——
   * 继续现在有自己的入口（resumeGoalMode），这里什么都不做，进度与用量都留着。
   */
  test('同正文落在暂停的目标上：什么都不做（不 resume、不重建），仍是暂停', async () => {
    const h = goalHarness()
    h.goalState = { goal: { objective: '旧目标', status: 'paused' } }
    await applyGoal({ session: h.session, root: ROOT, availability: availabilityOf(true, true), goal: '旧目标' })
    expect(h.calls).toEqual([])
    expect(h.goalState).toMatchObject({ goal: { status: 'paused' } })
  })

  test('删除：goal 为 null 时 dropGoal 并清状态', async () => {
    const h = goalHarness()
    h.goalState = { goal: { objective: '旧目标', status: 'active' } }
    await applyGoal({ session: h.session, root: ROOT, availability: availabilityOf(true, true), goal: null })
    expect(h.calls).toEqual(['drop'])
    expect(h.goalState).toBeUndefined()
  })

  test('正在流式输出时改目标要把目标上下文 steer 进去', async () => {
    const h = goalHarness()
    h.streaming = true
    await applyGoal({ session: h.session, root: ROOT, availability: availabilityOf(true, true), goal: '把测试迁完' })
    expect(h.calls).toContain('sendGoalModeContext')
  })

  test('设置里关掉目标模式时抛 engine.goal_unavailable', async () => {
    const h = goalHarness()
    const error = await applyGoal({
      session: h.session,
      root: ROOT,
      availability: availabilityOf(true, false),
      goal: '随便',
    }).catch((e: unknown) => e)
    expect((error as AppError).code).toBe(EngineErrorCode.goalUnavailable)
    expect(h.calls).toEqual([])
  })
})

/** 工具结果里的正文（判断文案用） */
function textOf(result: { readonly content: unknown }): string {
  const content = result.content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) => {
      const entry = block as { readonly type?: unknown; readonly text?: unknown }
      return entry.type === 'text' && typeof entry.text === 'string' ? [entry.text] : []
    })
    .join('\n')
}
