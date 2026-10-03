/*
 * 期望态那两种寿命的判据：模型与权限落**配置**，计划与目标只住**会话**。
 *
 * 这一格是「入口还没建会话时，点一下到底改了什么」的唯一产地。判错的方向很贵：
 * 把只住会话的那两格报成配置，屏幕会显示「已改」而实际没落笔；反过来会让模型那一格
 * 点了没反应（要等建会话才生效）。
 *
 * 自检跑法：bun test src/__tests__/expected-state.test.ts
 */

import { describe, expect, it } from 'bun:test'
import type { ModelRegistry, Settings } from '@oh-my-pi/pi-coding-agent'
import { lookup } from '@oh-my-pi/pi-coding-agent/config/registry'
import { Settings as SettingsStore } from '@oh-my-pi/pi-coding-agent/config/settings'
import {
  applyExpectedSelection,
  buildExpectedState,
  EXPECTED_POSTURES,
  type ExpectedServer,
  type ExpectedSkill,
  type ExpectedState,
} from '../expected-state.ts'

/*
 * 一本真的在内存里的设置（官方 `Settings.isolated`），不是手搓的假对象。
 *
 * 18.5.0 起读值走**注册表句柄**（`Setting.get(scope)` 要读 `scope.valueCache`）、写值走
 * `scope.writeValue`，所以「有个 get/set 方法」的鸭子类型不再成立 —— 假对象上那两下会
 * 直接在 SDK 里炸。用官方给测试的那一支，读写的语义与线上同一份。
 *
 * `overrides` 只做**播种**（它压过 global 层），所以这里分两个入口：
 * `settings()` 是一本空的（可写、可读回），`config()` 是播种只读的。
 */
function settings(): Settings {
  return SettingsStore.isolated()
}

/* 播种：给 buildExpectedState 用，判据是读出来的值。override 层压过 global，正合「配好的」。 */
function config(values: Record<string, unknown>): Settings {
  return SettingsStore.isolated(values)
}

/** 写进去了没有：读回真实的那一格，而不是去问一本假账本。 */
const readBack = (settings: Settings, path: string): unknown => lookup(path)?.get(settings)

/* 一条带梯子的推理模型：字段照 pi-catalog 的形状（reasoning / thinking.efforts / defaultLevel）。 */
function reasoningModel(options?: {
  readonly defaultLevel?: string
  readonly efforts?: readonly string[]
}): Record<string, unknown> {
  return {
    provider: 'deepseek',
    id: 'deepseek-flash',
    name: 'DeepSeek Flash',
    reasoning: true,
    thinking: {
      efforts: options?.efforts ?? ['low', 'high', 'max'],
      ...(options?.defaultLevel === undefined ? {} : { defaultLevel: options.defaultLevel }),
    },
  }
}

const registry = (model: Record<string, unknown>): ModelRegistry =>
  ({
    getAvailable: () => [model],
    /* 有钥匙：`expectedModel` 的回落会用它挑第一条可用的模型。 */
    hasConcreteAuth: () => true,
  }) as unknown as ModelRegistry

/*
 * 入口报出去的「此刻」必须与建会话之后**真正落定的那个值**一致。
 *
 * 这一格报错不会崩，只会让屏幕显示一个永远不到来的状态 —— 比崩更难发现。
 * 两个已实测的分叉方向都钉在这里（2026-10-01 对着真实 home 量过）：
 *
 *   1. `plan.defaultOnStartup: true`：上游只有 interactive-mode.ts / print-mode.ts 读它，
 *      桥走 createAgentSession 一个字都不读。照配置报 on 会报出一个永不到来的 on。
 *   2. `defaultThinkingLevel: auto`：上游认 auto，但本产品不出这一档，会话收敛时会被换成
 *      模型自己的默认档。照配置报 auto（或自行退回最深一档）都与会话分叉。
 */
describe('入口的「此刻」不许报会话到不了的值', () => {
  const build = (settings: Settings, model = reasoningModel()): Promise<ExpectedState> =>
    buildExpectedState({
      registry: registry(model),
      settings,
      skills: [],
      servers: [],
      skillSourceOf: (source) => source,
      thinkingOptions: new Map(),
    })

  it('计划那一格只认会话起手值：defaultOnStartup 开着也报 off', async () => {
    /* 会话刚建、没进过计划模式 —— 权威态就是 off（readSelectors 读 getPlanModeState）。 */
    const state = await build(config({ 'plan.enabled': true, 'plan.defaultOnStartup': true }))

    expect(state.controls.find((control) => control.id === 'plan')?.current).toBe('off')
  })

  it('档位那一格报会话收敛后的那一档：配置 auto 时报模型自己的默认档', async () => {
    /* 会话侧：auto 会被 settleThinking 换成模型声明的 defaultLevel。 */
    const state = await build(
      config({ defaultThinkingLevel: 'auto', 'tools.approvalMode': 'yolo' }),
      reasoningModel({ defaultLevel: 'high' }),
    )

    expect(state.controls.find((control) => control.id === 'thinking')?.current).toBe('high')
  })

  it('配置那一档不在梯子上时报收敛后的落点，不报梯子最深一档', async () => {
    /* 'medium' 不在这条模型的梯子上；收敛后落到模型声明的 'low'，不是最深一档。 */
    const state = await build(
      config({ defaultThinkingLevel: 'medium' }),
      reasoningModel({ defaultLevel: 'low', efforts: ['low', 'high'] }),
    )

    expect(state.controls.find((control) => control.id === 'thinking')?.current).toBe('low')
  })
})

describe('改一格期望态：落配置还是落会话', () => {
  it('模型那一格落配置 —— 写角色而不是写死 provider', async () => {
    const held = settings()
    const outcome = await applyExpectedSelection({
      settings: held,
      configId: 'model',
      value: 'deepseek/deepseek-flash',
    })

    expect(outcome).toBe('config')
    /* 写的是角色：omp 自己按角色解析，我们这边不再解析一次。 */
    expect(held.getModelRole('default')).toBe('deepseek/deepseek-flash')
  })

  it('模型那一格写完要落盘 —— 不 flush 就是「点了没反应」', async () => {
    const held = settings()
    await applyExpectedSelection({
      settings: held,
      configId: 'model',
      value: 'deepseek/deepseek-flash',
    })

    /* 写完要落盘：这一格真的被写进去了，且落在 global 层（真落盘那一层）。 */
    expect(held.getModelRole('default')).toBe('deepseek/deepseek-flash')
    expect(held.getProvenance(lookup('modelRoles')!)).toBe('global')
  })

  it('权限那一格落配置，写的是上游的 approvalMode 而不是我们的档位名', async () => {
    const held = settings()
    const outcome = await applyExpectedSelection({
      settings: held,
      configId: 'permission',
      value: 'auto',
    })

    expect(outcome).toBe('config')
    /* 'auto' 是我们的名字，落到上游是 yolo（见 EXPECTED_POSTURES）。 */
    expect(readBack(held, 'tools.approvalMode')).toBe('yolo')
    /* 落的是 global 层（真落盘那一层），不是 runtime override。 */
    expect(held.getProvenance(lookup('tools.approvalMode')!)).toBe('global')
  })

  it('每一档权限都映到一个上游模式，且三档互不相同', async () => {
    const modes = new Set<string>()
    for (const posture of EXPECTED_POSTURES) {
      const held = settings()
      await applyExpectedSelection({ settings: held, configId: 'permission', value: posture.value })
      expect(readBack(held, 'tools.approvalMode')).toBe(posture.mode)
      modes.add(posture.mode)
    }

    expect(modes.size).toBe(EXPECTED_POSTURES.length)
  })

  it('计划与目标两格如实报会话 —— 不静默当成功', async () => {
    for (const configId of ['plan', 'goal']) {
      const held = settings()
      const outcome = await applyExpectedSelection({ settings: held, configId, value: 'on' })

      expect(outcome).toBe('session')
      /* 一个字都不该写：写了就是拿配置冒充会话状态。 */
      expect(held.getProvenance(lookup('plan.enabled')!)).toBe('default')
      expect(held.revision).toBe(1)
    }
  })

  it('认不得的格子与认不得的档位都报错，不静默吞掉', async () => {
    await expect(
      applyExpectedSelection({ settings: settings(), configId: 'nope', value: 'on' }),
    ).rejects.toThrow('no expected-state selector is called nope')

    await expect(
      applyExpectedSelection({ settings: settings(), configId: 'permission', value: 'nope' }),
    ).rejects.toThrow('no approval posture is called nope')
  })
})

/*
 * 两张清单的形状：入口那一格读的是「配成什么样」，不是「此刻连上没有」。
 *
 * 这里只钉形状契约（两处读法必须给出同一种形状），值本身由各自的轻量发现 API 决定。
 */
describe('清单的形状', () => {
  it('技能那一格带上路径与来源，并如实报 disableModelInvocation', () => {
    const skill: ExpectedSkill = {
      name: 'pdf',
      description: 'reads pdfs',
      path: '/home/agent/skills/pdf/SKILL.md',
      source: 'user',
      kind: null,
      disableModelInvocation: true,
    }

    expect(skill.path.endsWith('SKILL.md')).toBe(true)
    expect(skill.kind).toBeNull()
  })

  it('MCP 那一格入口只报配置层：默认 disconnected、0 个工具', () => {
    const server: ExpectedServer = {
      id: 'playwright',
      name: 'playwright',
      status: 'disconnected',
      toolCount: 0,
      lastError: null,
    }

    /* 连接状态是连接层的事实（要 spawn 子进程），入口这一格不猜它。 */
    expect(server.status).toBe('disconnected')
    expect(server.toolCount).toBe(0)
    expect(server.lastError).toBeNull()
  })
})
