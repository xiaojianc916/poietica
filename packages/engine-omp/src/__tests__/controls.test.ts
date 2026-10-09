import './omp-home'

import { describe, expect, test } from 'bun:test'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import type { EngineSessionEvent, OpenSessionSpec } from '@poietica/engine'
import { noopLogger } from '@poietica/foundation'
import { InteractionBroker } from '../interactions/broker'
import { applyPosture } from '../posture'
import { LiveProjector } from '../projector/live'
import { OmpSession, type OmpSessionHost } from '../session'
import { readSetting } from '../settings-access'

/*
 * 控件（12 页 §7.7、§12.3 的去向表）：迁移自 legacy thinking.test.ts，另加一轮自己产出的
 * 时间线判断「本轮结束后就是空闲」。
 *
 * 关键的一条：思考档位的候选是**这条模型自己的梯子**（omp 的 getAvailableThinkingLevels），
 * 不是一张写死的四档表 —— 写死一张通用表的代码会在这里红。
 *
 * legacy 顶部那一段「收敛」判据（旧版本留下的 off / auto 要收掉、换过模型之后落到默认档）
 * 在新树里没有落点：新树不保存第二份梯子，档位直接来自 omp 自己（12 页 §7.7 的表），
 * 收敛那一趟由 omp 的 applyAutoThinkingLevel 负责，产品侧只把解析结果作为 OpenSessionSpec.thinking 传下去。
 *
 * 被测对象是 OmpSession 自己：用手工组装的 OmpSessionHost（hostOf）驱动，不起进程、不碰磁盘。
 * 这是「被测对象自己的声明」——存根只在测试里，不进产品代码。
 */
const NOW = 1_700_000_000_000

const SPEC: OpenSessionSpec = {
  key: 'controls',
  cwd: 'C:\\work',
  sessionFile: null,
  posture: 'ask',
  model: null,
  thinking: null,
}

const EMPTY_PAGE: Awaited<ReturnType<OmpSessionHost['page']>> = {
  items: [],
  tasks: [],
  interactions: [],
  attachments: [],
  todos: [],
  prompts: [],
  meta: {},
  hasMoreOlder: false,
}

function hostOf(over: Partial<OmpSessionHost> = {}): OmpSessionHost {
  /*
   * 计划与目标的状态住在**会话**那一侧（真实适配器里由 setPlanModeState / goalRuntime 持），
   * 控件表每次现读它（livePlanMode / liveGoal）。夹具因此也得是有状态的：恒返回 false / null
   * 会让「切了模式但控件表没跟着变」这类缺陷在这里看起来是通过的。
   */
  let planMode = false
  let goal: string | null = null
  return {
    spec: SPEC,
    logger: noopLogger,
    broker: new InteractionBroker(() => NOW),
    projector: new LiveProjector({ now: () => NOW }),
    prompt: async () => true,
    steer: async () => undefined,
    abort: async () => undefined,
    disposeSession: async () => undefined,
    queueOf: () => ({ steering: [], followUp: [] }),
    popLastQueued: () => true,
    clearQueue: () => undefined,
    setQueueMode: () => undefined,
    setApprovalMode: () => undefined,
    grantTool: () => undefined,
    liveModel: () => null,
    liveThinking: () => null,
    lastAssistant: () => undefined,
    contextUsage: () => null,
    thinkingChoices: () => [],
    modelChoices: () => [],
    modelLabel: (model) => `${model.provider}/${model.id}`,
    thinkingFallback: () => [],
    defaultThinking: () => null,
    setModelOnSession: async () => undefined,
    setThinkingOnSession: () => undefined,
    skillMessage: async () => null,
    /* 计划 / 目标：默认「可用 + 没开」，需要哪一档的用例自己 over 掉 */
    applyPlanMode: async (enabled) => {
      planMode = enabled
    },
    applyGoal: async (next) => {
      goal = next
    },
    planAvailable: () => true,
    goalAvailable: () => true,
    livePlanMode: () => planMode,
    liveGoal: () => goal,
    liveGoalSnapshot: () =>
      goal === null
        ? null
        : {
            objective: goal,
            completionCriterion: null,
            status: 'active' as const,
            turnsUsed: 0,
            tokensUsed: 0,
            wallClockMs: 0,
          },
    page: async () => EMPTY_PAGE,
    now: () => NOW,
    ...over,
  }
}

function sessionOf(over: Partial<OmpSessionHost> = {}): OmpSession {
  return new OmpSession(hostOf(over), { sessionId: 's1', sessionFile: 'f1' })
}

/** 一根只收 controls 事件的记录线；收窄在入口处做，断言读到的就是 controls 那一支 */
type ControlsEvent = Extract<EngineSessionEvent, { type: 'controls' }>

function controlsOf(session: OmpSession): ControlsEvent[] {
  const seen: ControlsEvent[] = []
  session.subscribe((event) => {
    if (event.type === 'controls') seen.push(event)
  })
  return seen
}

describe('OmpSession 的控件', () => {
  test('控件形状完整：模型、思考、姿态、计划模式、目标、上下文都在', () => {
    expect(sessionOf().controls()).toEqual({
      model: { current: null, choices: [] },
      thinking: { current: null, choices: [] },
      posture: 'ask',
      planMode: false,
      goal: null,
      goalSnapshot: null,
      available: { plan: true, goal: true },
      context: null,
    })
  })

  test('agent 没报名单时退回当前这一条，label 走 host 给的写法（不是 provider/id）', () => {
    const session = new OmpSession(
      hostOf({
        spec: { ...SPEC, model: { provider: 'deepseek', id: 'v4-pro' } },
        modelLabel: () => 'DeepSeek V4 Pro',
      }),
      { sessionId: 's1', sessionFile: 'f1' },
    )
    expect(session.controls().model).toEqual({
      current: { provider: 'deepseek', id: 'v4-pro' },
      choices: [
        { ref: { provider: 'deepseek', id: 'v4-pro' }, label: 'DeepSeek V4 Pro', reasoning: true, images: true },
      ],
    })
  })

  test('候选来自 agent 的清单：label 用模型名（不是 provider/id）', () => {
    const session = sessionOf({
      liveModel: () => ({ provider: 'deepseek', id: 'v4-pro' }),
      modelChoices: () => [
        { ref: { provider: 'deepseek', id: 'v4-pro' }, label: 'DeepSeek V4 Pro', reasoning: true, images: true },
        { ref: { provider: 'deepseek', id: 'v4-flash' }, label: 'DeepSeek V4 Flash', reasoning: true, images: true },
      ],
    })
    expect(session.controls().model.choices.map((c) => c.label)).toEqual(['DeepSeek V4 Pro', 'DeepSeek V4 Flash'])
  })

  test('当前模型不在候选清单里时补一条在最前（会话自己挑的模型也要画得出来）', () => {
    const session = sessionOf({
      liveModel: () => ({ provider: 'custom', id: 'local-model' }),
      modelChoices: () => [
        { ref: { provider: 'deepseek', id: 'v4-pro' }, label: 'DeepSeek V4 Pro', reasoning: true, images: true },
      ],
      modelLabel: () => '本地模型',
    })
    expect(session.controls().model.choices).toEqual([
      { ref: { provider: 'custom', id: 'local-model' }, label: '本地模型', reasoning: true, images: true },
      { ref: { provider: 'deepseek', id: 'v4-pro' }, label: 'DeepSeek V4 Pro', reasoning: true, images: true },
    ])
  })

  test('思考档位的候选是该模型自己的梯子，不是写死的四档表', () => {
    const session = new OmpSession(
      hostOf({
        spec: { ...SPEC, thinking: 'high' },
        // 该模型只认这三档：写死 low/medium/high/max 的实现会在这里红
        thinkingChoices: () => ['minimal', 'high', 'max'],
      }),
      { sessionId: 's1', sessionFile: 'f1' },
    )
    expect(session.controls().thinking).toEqual({
      current: 'high',
      choices: [
        { id: 'minimal', label: 'minimal' },
        { id: 'high', label: 'high' },
        { id: 'max', label: 'max' },
      ],
    })
  })

  test('梯子为空（不思考的模型）时候选是空表，不编四档', () => {
    const session = new OmpSession(hostOf({ spec: { ...SPEC, thinking: 'high' } }), {
      sessionId: 's1',
      sessionFile: 'f1',
    })
    expect(session.controls().thinking).toEqual({ current: 'high', choices: [] })
  })

  /*
   * 真机实测（用户报「模型卡片开始时没有思考强度，切换一次才出现」）：会话还没水合时
   * omp 的 `getAvailableThinkingLevels()` 是空的。候选此时退回**这条模型静态的梯子**
   * （模型目录里烤好的 efforts），选中值退回模型声明的默认档 —— 与入口页草稿表同一条。
   */
  test('会话没报梯子时退回模型静态梯子与默认档，卡片一开始就画得出思考强度', () => {
    const session = new OmpSession(
      hostOf({
        spec: { ...SPEC, model: { provider: 'deepseek', id: 'v4-pro' }, thinking: null },
        liveThinking: () => null,
        thinkingChoices: () => [],
        thinkingFallback: () => ['low', 'high', 'max'],
        defaultThinking: () => 'high',
      }),
      { sessionId: 's1', sessionFile: 'f1' },
    )
    expect(session.controls().thinking).toEqual({
      current: 'high',
      choices: [
        { id: 'low', label: 'low' },
        { id: 'high', label: 'high' },
        { id: 'max', label: 'max' },
      ],
    })
  })

  test('会话报出的梯子优先于静态回退（两条来源都要认）', () => {
    const session = sessionOf({
      thinkingChoices: () => ['minimal', 'max'],
      thinkingFallback: () => ['low', 'high', 'max'],
      defaultThinking: () => 'high',
    })
    expect(session.controls().thinking.choices).toEqual([
      { id: 'minimal', label: 'minimal' },
      { id: 'max', label: 'max' },
    ])
  })

  /*
   * 真机实测（P5 手工验收）：spec 里没有模型是常规路径（`null = 使用默认模型`），
   * 这时 omp 自己会挑一条 —— 控件表要报**会话此刻真的在用哪一条**，而不是 null。
   *
   * 钉住的是这条不变式：`controls().model.current` 与 `choices[0].ref` 都不许是空串。
   * 契约（packages/engine/src/values.ts 的 ModelRef）要求两格都非空，发一个空 ref
   * 上去会让 core 侧的 zod 校验整份退回，UI 那一排选择器永远拿不到表。
   */
  test('会话自己选出了模型：控件表报的是它，不是构造时那份 null', () => {
    const session = sessionOf({ liveModel: () => ({ provider: 'deepseek', id: 'chat' }) })
    expect(session.controls().model).toEqual({
      current: { provider: 'deepseek', id: 'chat' },
      choices: [{ ref: { provider: 'deepseek', id: 'chat' }, label: 'deepseek/chat', reasoning: true, images: true }],
    })
  })

  test('会话自己改过档位：控件表报的是会话此刻的档，不是最初要的那一档', () => {
    const session = sessionOf({ spec: { ...SPEC, thinking: 'low' }, liveThinking: () => 'max' })
    expect(session.controls().thinking.current).toBe('max')
  })

  test('会话还没报出模型时退回构造时那一份（两条来源都要认）', () => {
    const session = new OmpSession(
      hostOf({
        spec: { ...SPEC, model: { provider: 'anthropic', id: 'claude-opus-4-5' } },
        liveModel: () => null,
      }),
      { sessionId: 's1', sessionFile: 'f1' },
    )
    expect(session.controls().model.current).toEqual({ provider: 'anthropic', id: 'claude-opus-4-5' })
  })

  test('每一种控件变化都 emit 一次 controls，值也真的改了', async () => {
    const session = sessionOf()
    const seen = controlsOf(session)

    await session.setModel({ provider: 'a', id: 'b' })
    expect(seen.at(-1)?.controls.model.current).toEqual({ provider: 'a', id: 'b' })

    session.setThinking('max')
    expect(seen.at(-1)?.controls.thinking.current).toBe('max')

    session.setPosture('full-access')
    expect(seen.at(-1)?.controls.posture).toBe('full-access')

    await session.setPlanMode(true)
    expect(seen.at(-1)?.controls.planMode).toBe(true)

    await session.setGoal('把测试迁完')
    expect(seen.at(-1)?.controls.goal).toBe('把测试迁完')

    expect(seen).toHaveLength(5)
  })

  /*
   * 人把选择器拨回「直接执行」时，屏幕上可能正躺着一张待批准的计划卡片。那张卡属于计划模式：
   * 模式出去了它还在等答复，broker 那次 ask 就永远没人结 —— 那一轮收不了尾（模型等工具结果，
   * 屏幕等一个再也不会来的点击）。所以退出时必须按 dismiss 兑现，答复与「否决」同效。
   */
  test('setPlanMode(false) 先把还在等的计划卡片按 dismiss 兑现', async () => {
    const host = hostOf()
    const session = new OmpSession(host, { sessionId: 's1', sessionFile: 'f1' })
    const asked = host.broker.ask({
      kind: 'plan',
      title: '重构输入层',
      planFilePath: 'local://x-plan.md',
      planMarkdown: '# 计划',
    })
    expect(session.interactions()).toHaveLength(1)

    await session.setPlanMode(false)

    expect(await asked).toEqual({ kind: 'dismiss' })
    expect(session.interactions()).toHaveLength(0)
  })

  /*
   * 真实故障「输入框显示的模型与我用的模型不一样」：先前 setModel/setThinking 只改本地
   * 那一格，从不交给 omp —— 屏幕报 B，会话仍在跑 A。这两条钉住「改一次就真的下发一次」。
   */
  test('setModel 真的下发到会话，不是只改本地那一格', async () => {
    const applied: { provider: string; id: string }[] = []
    const session = sessionOf({
      setModelOnSession: async (model) => {
        applied.push(model)
      },
    })
    await session.setModel({ provider: 'deepseek', id: 'v4-flash' })
    expect(applied).toEqual([{ provider: 'deepseek', id: 'v4-flash' }])
  })

  test('setThinking 真的下发到会话，不是只改本地那一格', () => {
    const applied: string[] = []
    const session = sessionOf({
      setThinkingOnSession: (level) => {
        applied.push(level)
      },
    })
    session.setThinking('max')
    expect(applied).toEqual(['max'])
  })

  test('姿态的写入落在会话设置上，且映射到 omp 的 approvalMode', () => {
    const settings = Settings.isolated()
    const session = sessionOf({ setApprovalMode: (posture) => applyPosture(settings, posture) })
    session.setPosture('auto-edit')
    // 映射表是 posture.ts 的 POSTURE_MODE：auto-edit → write
    expect(readSetting(settings, 'tools.approvalMode')).toBe('write')
    expect(session.controls().posture).toBe('auto-edit')
  })
})

describe('一轮的终局在控件上是空闲', () => {
  test('submit 之后是 running，agent_end 收轮之后回到 idle', async () => {
    const session = sessionOf()
    await session.submit({ text: '你好', images: [], files: [], skills: [], deliverAs: 'turn' })
    expect(session.state()).toBe('running')
    session.finishTurn()
    expect(session.state()).toBe('idle')
  })
})
