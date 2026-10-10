import './omp-home'

import { describe, expect, test } from 'bun:test'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import { GoalRuntime } from '@oh-my-pi/pi-coding-agent/goals/runtime'
import type { GoalModeState } from '@oh-my-pi/pi-coding-agent/goals/state'
import { EngineErrorCode, type EngineSession, type EngineSessionEvent, type OpenSessionSpec } from '@poietica/engine'
import { type AppError, noopLogger, SystemErrorCode } from '@poietica/foundation'
import { wrapOmpSession } from '../omp-session-adapter'
import { type Availability, applyGoal, type GoalCapableSession, pauseGoalMode, resumeGoalMode } from '../plan-goal'
import { overrideSetting } from '../settings-access'

/*
 * 目标的暂停 / 继续 / 改正文（审查 R-10）。
 *
 * 用的是 **omp 真实的 GoalRuntime**（不是手写的假 runtime）：哪些状态转移 omp 收、哪些会抛
 * （例如「暂停的目标不能 replace」「完成之后不能 replace」），只有真 runtime 说了算。
 * 宿主那一面（状态格、工具集、事件）按 omp AgentSession 的接线自己搭。
 */

const ON: () => Availability = () => ({ plan: true, goal: true })
const GOAL_OFF: () => Availability = () => ({ plan: true, goal: false })
const ROOT = Settings.isolated()

interface RealGoal {
  readonly session: GoalCapableSession
  readonly runtime: GoalRuntime
  state(): GoalModeState | undefined
  tools(): readonly string[]
  /** runtime 每次 goal_updated 的「状态:正文」 */
  readonly updates: string[]
  /** sendGoalModeContext 被调用的次数 */
  steered(): number
  streaming: boolean
}

function realGoal(): RealGoal {
  let state: GoalModeState | undefined
  let tools: string[] = ['read', 'write']
  let steers = 0
  const updates: string[] = []
  const runtime = new GoalRuntime({
    getState: () => state,
    setState: (next) => {
      state = next
    },
    getCurrentUsage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    emit: (event) => {
      if (event.type === 'goal_updated') updates.push(`${event.goal?.status ?? 'null'}:${event.goal?.objective ?? ''}`)
    },
    persist: () => undefined,
    sendHiddenMessage: async () => undefined,
  })
  const h: RealGoal = {
    session: undefined as never,
    runtime,
    state: () => state,
    tools: () => tools,
    updates,
    steered: () => steers,
    streaming: false,
  }
  const session: GoalCapableSession = {
    getEnabledToolNames: () => [...tools],
    hasBuiltInTool: (name) => name === 'goal',
    setActiveToolsByName: async (names) => {
      tools = [...names]
    },
    getGoalModeState: () => state as never,
    setGoalModeState: (next) => {
      state = next as GoalModeState | undefined
    },
    goalRuntime: runtime,
    get isStreaming() {
      return h.streaming
    },
    sendGoalModeContext: async () => {
      steers += 1
    },
  }
  return Object.assign(h, { session })
}

async function started(objective = '把测试迁完'): Promise<RealGoal> {
  const h = realGoal()
  await applyGoal({ session: h.session, root: ROOT, availability: ON, goal: objective })
  h.updates.length = 0
  return h
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return await promise.then(
    () => null,
    (error: unknown) => (error as AppError).code ?? String(error),
  )
}

describe('暂停 / 继续（R-10）', () => {
  test('G1 暂停进行中的目标：状态 paused、goal 工具摘掉、不 steer、不打断', async () => {
    const h = await started()
    h.streaming = true
    await pauseGoalMode({ session: h.session })
    expect(h.state()?.goal.status).toBe('paused')
    expect(h.state()?.enabled).toBe(false)
    expect(h.tools()).not.toContain('goal')
    expect(h.steered()).toBe(0)
  })

  test('G2 暂停已暂停的目标：什么都不做', async () => {
    const h = await started()
    await pauseGoalMode({ session: h.session })
    h.updates.length = 0
    await pauseGoalMode({ session: h.session })
    expect(h.updates).toEqual([])
    expect(h.state()?.goal.status).toBe('paused')
  })

  test('G3 没有目标时暂停：kernel.not_found', async () => {
    const h = realGoal()
    expect(await codeOf(pauseGoalMode({ session: h.session }))).toBe(SystemErrorCode.notFound)
  })

  test('G4 继续已暂停的目标：回到 active、goal 工具回来；正在跑时 steer 一次', async () => {
    const h = await started()
    await pauseGoalMode({ session: h.session })
    h.streaming = true
    await resumeGoalMode({ session: h.session, root: ROOT, availability: ON })
    expect(h.state()?.goal.status).toBe('active')
    expect(h.state()?.enabled).toBe(true)
    expect(h.tools()).toContain('goal')
    expect(h.steered()).toBe(1)
  })

  test('G5 继续进行中的目标：什么都不做', async () => {
    const h = await started()
    await resumeGoalMode({ session: h.session, root: ROOT, availability: ON })
    expect(h.updates).toEqual([])
  })

  test('G6 没有已暂停的目标时继续：kernel.not_found', async () => {
    const h = realGoal()
    expect(await codeOf(resumeGoalMode({ session: h.session, root: ROOT, availability: ON }))).toBe(
      SystemErrorCode.notFound,
    )
  })

  test('G7 设置里关掉目标模式：继续抛 engine.goal_unavailable；暂停与清除照常', async () => {
    const h = await started()
    await pauseGoalMode({ session: h.session })
    expect(await codeOf(resumeGoalMode({ session: h.session, root: ROOT, availability: GOAL_OFF }))).toBe(
      EngineErrorCode.goalUnavailable,
    )
    const other = await started()
    expect(await codeOf(pauseGoalMode({ session: other.session }))).toBeNull()
    expect(
      await codeOf(applyGoal({ session: other.session, root: ROOT, availability: GOAL_OFF, goal: null })),
    ).toBeNull()
    expect(other.state()).toBeUndefined()
  })
})

describe('改正文 / 清除（R-10）', () => {
  test('E1 改已暂停目标的正文：换成新正文、仍是暂停、goal 工具不回来', async () => {
    const h = await started('甲')
    await pauseGoalMode({ session: h.session })
    await applyGoal({ session: h.session, root: ROOT, availability: ON, goal: '乙' })
    expect(h.state()?.goal.objective).toBe('乙')
    expect(h.state()?.goal.status).toBe('paused')
    expect(h.tools()).not.toContain('goal')
  })

  test('E2 改进行中目标的正文：replace，仍进行中', async () => {
    const h = await started('甲')
    const before = h.state()?.goal.id
    await applyGoal({ session: h.session, root: ROOT, availability: ON, goal: '乙' })
    expect(h.state()?.goal.objective).toBe('乙')
    expect(h.state()?.goal.status).toBe('active')
    expect(h.state()?.goal.id).not.toBe(before)
  })

  test('E3 正文没变：什么都不做（不重建，目标 id 不变）', async () => {
    const h = await started('甲')
    const before = h.state()?.goal.id
    await applyGoal({ session: h.session, root: ROOT, availability: ON, goal: '  甲 ' })
    expect(h.updates).toEqual([])
    expect(h.state()?.goal.id).toBe(before)
  })

  test('E4 上一个目标已完成：再设就新建一个进行中的目标', async () => {
    const h = await started('甲')
    await h.runtime.completeGoalFromTool()
    await applyGoal({ session: h.session, root: ROOT, availability: ON, goal: '乙' })
    expect(h.state()?.goal.objective).toBe('乙')
    expect(h.state()?.goal.status).toBe('active')
  })

  test('E5 清除：状态清掉，goal 工具摘掉', async () => {
    const h = await started('甲')
    await applyGoal({ session: h.session, root: ROOT, availability: ON, goal: null })
    expect(h.state()).toBeUndefined()
    expect(h.tools()).not.toContain('goal')
  })

  test('E6 设置里关掉目标模式之后：仍能清除挂着的目标', async () => {
    const h = await started('甲')
    expect(await codeOf(applyGoal({ session: h.session, root: ROOT, availability: GOAL_OFF, goal: null }))).toBeNull()
    expect(h.state()).toBeUndefined()
  })
})

/* ── 会话层：控件只报一次、完成之后开关能重新打开 ───────────────────────── */

interface Wrapped {
  readonly session: EngineSession
  readonly events: EngineSessionEvent[]
  readonly runtime: GoalRuntime
}

async function wrapped(): Promise<Wrapped> {
  const settings = Settings.isolated()
  overrideSetting(settings, 'goal.enabled', true)
  let state: GoalModeState | undefined
  let tools: string[] = ['read', 'write']
  const listeners = new Set<(event: Record<string, unknown>) => void>()
  const runtime = new GoalRuntime({
    getState: () => state,
    setState: (next) => {
      state = next
    },
    getCurrentUsage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    /* 与 omp AgentSession 同：goal_updated 同步交给订阅者 */
    emit: (event) => {
      for (const listener of listeners) listener({ ...event })
    },
    persist: () => undefined,
    sendHiddenMessage: async () => undefined,
  })
  const agentSession = {
    sessionId: 'session-goal',
    sessionFile: 'session-goal.jsonl',
    settings,
    messages: [],
    skills: [],
    sessionManager: { getArtifactsDir: () => null, getSessionId: () => 'session-goal', getCwd: () => '/' },
    subscribe: (listener: (event: Record<string, unknown>) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    prompt: async () => true,
    promptCustomMessage: async () => true,
    steer: async () => undefined,
    followUp: async () => undefined,
    abort: async () => undefined,
    dispose: async () => undefined,
    setPromptDropped: () => undefined,
    setThinkingLevel: () => undefined,
    setSteeringMode: () => undefined,
    setFollowUpMode: () => undefined,
    getQueuedMessages: () => ({ steering: [], followUp: [] }),
    removeQueuedMessage: () => false,
    getContextUsage: () => undefined,
    getLastAssistantMessage: () => undefined,
    getAvailableThinkingLevels: () => [],
    getEnabledToolNames: () => [...tools],
    hasBuiltInTool: (name: string) => name === 'goal',
    setActiveToolsByName: async (names: string[]) => {
      tools = [...names]
    },
    getGoalModeState: () => state,
    setGoalModeState: (next: GoalModeState | undefined) => {
      state = next
    },
    goalRuntime: runtime,
    isStreaming: false,
    sendGoalModeContext: async () => undefined,
  }
  const spec: OpenSessionSpec = {
    key: 'goal-actions',
    cwd: '/',
    sessionFile: null,
    posture: 'ask',
    model: null,
    thinking: null,
  }
  const session = await wrapOmpSession({
    spec,
    settings,
    agentSession,
    setToolUIContext: () => undefined,
    mcpManager: null,
    tools: new Map(),
    logger: noopLogger,
    subagentBus: null,
    initializeExtensions: async () => undefined,
    modelCatalog: () => null,
    model: null,
    thinking: null,
  })
  const events: EngineSessionEvent[] = []
  session.subscribe((event) => events.push(event))
  return { session, events, runtime }
}

function controlsEvents(events: readonly EngineSessionEvent[]) {
  return events.flatMap((event) => (event.type === 'controls' ? [event.controls] : []))
}

describe('会话层（R-10）', () => {
  test('S1 换已暂停目标的正文：只报一次控件，报的就是「已暂停 + 新正文」', async () => {
    const w = await wrapped()
    await w.session.setGoal('甲')
    await w.session.pauseGoal()
    w.events.length = 0
    await w.session.setGoal('乙')
    const reported = controlsEvents(w.events)
    expect(reported).toHaveLength(1)
    expect(reported[0]?.goalSnapshot).toMatchObject({ objective: '乙', status: 'paused' })
  })

  test('S2 暂停 / 继续经会话下发，控件跟着报 paused / active', async () => {
    const w = await wrapped()
    await w.session.setGoal('甲')
    await w.session.pauseGoal()
    expect(w.session.controls().goalSnapshot?.status).toBe('paused')
    await w.session.resumeGoal()
    expect(w.session.controls().goalSnapshot?.status).toBe('active')
  })

  test('S3 目标完成之后：controls.goal 报 null（输入框那颗开关能重新打开），快照仍报 complete', async () => {
    const w = await wrapped()
    await w.session.setGoal('甲')
    await w.runtime.completeGoalFromTool()
    expect(w.session.controls().goal).toBeNull()
    expect(w.session.controls().goalSnapshot?.status).toBe('complete')
  })

  test('S4 改动失败也报一次控件（屏幕回到真相），错误照抛', async () => {
    const w = await wrapped()
    w.events.length = 0
    const code = await w.session.pauseGoal().then(
      () => null,
      (error: unknown) => (error as AppError).code,
    )
    expect(code).toBe(SystemErrorCode.notFound)
    expect(controlsEvents(w.events)).toHaveLength(1)
  })
})
