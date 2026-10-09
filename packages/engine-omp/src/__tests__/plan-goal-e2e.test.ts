import './omp-home'

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import { defaultPlanAutosaveDir } from '@oh-my-pi/pi-coding-agent/plan-mode/plan-autosave'
import type { EngineSession, EngineSessionEvent, Interaction, OpenSessionSpec } from '@poietica/engine'
import { noopLogger } from '@poietica/foundation'
import { wrapOmpSession } from '../omp-session-adapter'
import { overrideSetting } from '../settings-access'

/*
 * 计划提交的端到端回归（04 §3.12、12 §8.5；产品负责人 2026-10-07 定稿的那张表）。
 *
 * 走的是`**真**`的 omp 解析路径（resolveApprovedPlan + readPlanFile + listPlanFiles）：计划文件
 * 按 agent 的落点摆一份在会话作用域的 artifacts 目录里（`<artifactsDir>/local/`），整条链
 * ——卡片内容、批准后的工具结果、参考路径、退模式、工具集还原、controls 补报、autosave——
 * 一次验完。会话本身是手工搭的假 AgentSession（与 projector 夹具同一条理由：真起一条会话要
 * 模型与密钥，而这里要证的是「桥读了哪一格、交了哪一份」，12 页 §12.3）。
 *
 * 这一条同时钉住一处**真实缺陷**：计划路径只能从 `sessionManager` 读（omp 的
 * artifacts 目录 + sessionId + cwd）。从 AgentSession 上直接读 artifactsDir / cwd 会拿到
 * undefined，`local://` 退到 `os.tmpdir()/omp-local/<id>`，agent 写的计划一份也解不出来。
 */

const PLAN_BODY = '# Auth\n\n正文。\n'

interface Harness {
  readonly session: EngineSession
  readonly events: EngineSessionEvent[]
  readonly fixture: {
    /** 会话作用域的 artifacts 目录（计划文件的落点） */
    readonly artifactsDir: string
    /** 会话的工作目录（autosave 的默认落点由它算） */
    readonly cwd: string
  }
  readonly referencePaths: string[]
  readonly goalCalls: string[]
  planState(): { enabled: boolean; planFilePath: string; workflow?: string; reentry?: boolean } | undefined
  goalState(): { goal: { objective: string; status: string } } | undefined
  tools(): readonly string[]
  /** 调 agent 那条路：写 xd://propose 时 omp 会调装上去的处理器 */
  proposed(title: string): Promise<unknown>
}

async function harness(): Promise<Harness> {
  const cwd = mkdtempSync(path.join(tmpdir(), 'poietica-plan-'))
  const artifactsDir = path.join(cwd, 'artifacts')
  mkdirSync(path.join(artifactsDir, 'local'), { recursive: true })
  writeFileSync(path.join(artifactsDir, 'local', 'auth-plan.md'), PLAN_BODY)

  const settings = Settings.isolated()
  overrideSetting(settings, 'plan.enabled', true)
  overrideSetting(settings, 'plan.autosave', true)
  overrideSetting(settings, 'goal.enabled', true)

  let planState: { enabled: boolean; planFilePath: string; workflow?: string; reentry?: boolean } | undefined
  let goalState: { goal: { objective: string; status: string } } | undefined
  let tools: string[] = ['read', 'write', 'bash', 'eval', 'task']
  let handler: ((title: string) => Promise<unknown>) | null = null
  const referencePaths: string[] = []
  const goalCalls: string[] = []

  const agentSession = {
    sessionId: 'session-plan',
    sessionFile: 'session-plan.jsonl',
    settings,
    messages: [],
    skills: [],
    /* 会话作用域的三格：计划文件与 autosave 都按它算 */
    sessionManager: {
      getArtifactsDir: () => artifactsDir,
      getSessionId: () => 'session-plan',
      getCwd: () => cwd,
    },
    subscribe: () => () => undefined,
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
    popLastQueuedMessage: () => undefined,
    clearQueue: () => undefined,
    getContextUsage: () => undefined,
    getLastAssistantMessage: () => undefined,
    getAvailableThinkingLevels: () => [],
    /* —— 计划那一面 —— */
    getEnabledToolNames: () => [...tools],
    hasBuiltInTool: (name: string) => name === 'write' || name === 'goal',
    /*
     * 故意写成**读 this 的方法**而不是箭头函数：真实 omp 的 AgentSession 是类实例，
     * setActiveToolsByName 读自己的私有字段 `this.#tools`。适配器一旦把方法从会话上
     * 摘下来再裸调，真实会话当场抛「undefined is not an object (evaluating
     * 'this.#tools')」，而箭头函数夹具察觉不到 —— 这一格就是那类回归的探针。
     */
    appliedToolSets: 0,
    setActiveToolsByName(this: { appliedToolSets: number }, names: string[]) {
      this.appliedToolSets += 1
      tools = [...names]
    },
    getPlanModeState: () => planState,
    setPlanModeState: (next: typeof planState) => {
      planState = next
    },
    setPlanProposalHandler: (next: typeof handler) => {
      handler = next
    },
    setPlanReferencePath: (url: string) => {
      referencePaths.push(url)
    },
    isStreaming: false,
    sendPlanModeContext: async () => undefined,
    /* —— 目标那一面 —— */
    getGoalModeState: () => goalState,
    setGoalModeState: (next: typeof goalState) => {
      goalState = next
    },
    goalRuntime: {
      createGoal: async ({ objective }: { objective: string }) => {
        goalCalls.push(`create:${objective}`)
        return { goal: { objective, status: 'active' } }
      },
      replaceGoal: async ({ objective }: { objective: string }) => {
        goalCalls.push(`replace:${objective}`)
        return { goal: { objective, status: 'active' } }
      },
      resumeGoal: async () => {
        goalCalls.push('resume')
        return { goal: { objective: '旧目标', status: 'active' } }
      },
      dropGoal: async () => {
        goalCalls.push('drop')
        return undefined
      },
    },
    sendGoalModeContext: async () => undefined,
  }

  const spec: OpenSessionSpec = {
    key: 'plan-proposal',
    cwd,
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

  return {
    session,
    events,
    fixture: { artifactsDir, cwd },
    referencePaths,
    goalCalls,
    planState: () => planState,
    goalState: () => goalState,
    tools: () => tools,
    proposed: (title) => {
      if (handler === null) throw new Error('计划处理器没装上')
      return handler(title)
    },
  }
}

/** 卡片不是同步挂出来的：解析计划要先读盘（动态 import + 读文件）。 */
async function waitForCard(session: EngineSession): Promise<Interaction> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const card = session.interactions()[0]
    if (card !== undefined) return card
    await Bun.sleep(5)
  }
  throw new Error('计划卡片一直没挂出来')
}

/** 工具结果里的正文（判断文案用） */
function textOf(result: unknown): string {
  const content = (result as { readonly content?: unknown } | null)?.content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) => {
      const entry = block as { readonly type?: unknown; readonly text?: unknown }
      return entry.type === 'text' && typeof entry.text === 'string' ? [entry.text] : []
    })
    .join('\n')
}

describe('计划提交：端到端', () => {
  test('批准：卡片读自 artifacts 目录，批准后参考路径 / 退模式 / 工具集 / controls / autosave 全到位', async () => {
    const h = await harness()
    await h.session.setPlanMode(true)
    expect(h.planState()).toMatchObject({ enabled: true, planFilePath: 'local://PLAN.md' })
    // 进模式收工具：bash / eval / task 摘掉，write 留着
    expect(h.tools()).toEqual(['read', 'write'])

    const pending = h.proposed('auth')
    const card = await waitForCard(h.session)
    expect(card).toMatchObject({
      kind: 'plan',
      title: 'auth',
      planFilePath: 'local://auth-plan.md',
      planMarkdown: PLAN_BODY,
    })

    h.session.respond(card.id, { kind: 'plan', decision: 'approve', feedback: null })
    const result = await pending

    expect(textOf(result)).toBe('计划已确认：local://auth-plan.md。按它执行。')
    expect(h.referencePaths).toEqual(['local://auth-plan.md'])
    expect(h.planState()).toBeUndefined()
    expect(h.tools()).toEqual(['read', 'write', 'bash', 'eval', 'task'])
    // 批准后补一次 controls：模式选择器跟着变回「直接执行」
    const lastControls = h.events.filter((event) => event.type === 'controls').at(-1)
    expect(lastControls?.controls.planMode).toBe(false)

    // autosave：批准的这份计划抄到了默认目录（plan.autosave 打开时）
    const dir = defaultPlanAutosaveDir(h.fixture.cwd)
    const saved = readdirSync(dir)
    expect(saved).toHaveLength(1)
    expect(readFileSync(path.join(dir, saved[0] as string), 'utf8')).toBe(PLAN_BODY)
  })

  test('要求修改：留在计划模式；实际计划文件与状态里那条不同时，把新路径写回状态', async () => {
    const h = await harness()
    await h.session.setPlanMode(true)

    const pending = h.proposed('auth')
    const card = await waitForCard(h.session)
    h.session.respond(card.id, { kind: 'plan', decision: 'revise', feedback: '补上回滚方案' })
    const result = await pending

    expect(textOf(result)).toBe('计划未获批准：local://auth-plan.md。用户意见：补上回滚方案。修改计划文件后重新提交。')
    // 留在计划模式里（出模式等于告诉模型可以动手了），但路径换了就写回去
    expect(h.planState()).toEqual({
      enabled: true,
      planFilePath: 'local://auth-plan.md',
      workflow: 'parallel',
      reentry: false,
    })
    expect(h.tools()).toEqual(['read', 'write'])
    expect(h.referencePaths).toEqual([])
  })

  test('否决：留在计划模式，工具集不收回去，也不登记参考路径', async () => {
    const h = await harness()
    await h.session.setPlanMode(true)

    const pending = h.proposed('auth')
    const card = await waitForCard(h.session)
    h.session.respond(card.id, { kind: 'plan', decision: 'reject', feedback: null })
    const result = await pending

    expect(textOf(result)).toBe('计划被否决：local://auth-plan.md。不要执行，也不要重新提交，等待用户指示。')
    expect(h.planState()).toMatchObject({ enabled: true })
    expect(h.referencePaths).toEqual([])
  })
})

describe('目标模式：端到端', () => {
  test('设置目标：goalRuntime 建目标、goal 工具加回活动集、状态与控件都跟上', async () => {
    const h = await harness()
    await h.session.setGoal('把测试迁完')

    expect(h.goalCalls).toEqual(['create:把测试迁完'])
    expect(h.tools()).toContain('goal')
    expect(h.goalState()).toMatchObject({ goal: { objective: '把测试迁完', status: 'active' } })
    expect(h.events.filter((event) => event.type === 'controls').at(-1)?.controls.goal).toBe('把测试迁完')
  })

  test('清除目标：dropGoal 并清状态，控件报 null、goal 工具不再留在活动集里', async () => {
    const h = await harness()
    await h.session.setGoal('把测试迁完')
    await h.session.setGoal(null)

    expect(h.goalCalls).toEqual(['create:把测试迁完', 'drop'])
    expect(h.goalState()).toBeUndefined()
    expect(h.events.filter((event) => event.type === 'controls').at(-1)?.controls.goal).toBeNull()
  })
})
