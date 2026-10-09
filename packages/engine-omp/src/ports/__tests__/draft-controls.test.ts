import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import type { OmpModel } from '../../omp-context'
import { writeGlobalSetting } from '../../settings-access'
import { draftControlsOf } from '../draft-controls'
import type { RegistryPort } from '../model-helpers'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'poietica-draft-'))
  made.push(dir)
  return dir
}

/** 一个只读的假注册表：all/available 都给同一份，find 按 provider+id 找。 */
function registryOf(models: readonly OmpModel[]): RegistryPort {
  return {
    all: () => models,
    available: () => models,
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: () => true,
    hydrateCredentialScopedModelCaches: async () => undefined,
    refreshInBackground: () => undefined,
  }
}

const MODELS: readonly OmpModel[] = [
  {
    provider: 'anthropic',
    id: 'claude-opus-4-5',
    name: 'Opus',
    reasoning: true,
    contextWindow: 200000,
    input: ['text', 'image'],
    thinking: { efforts: ['low', 'medium', 'high'], defaultLevel: 'medium' },
  },
  { provider: 'openai', id: 'gpt-5', name: 'GPT-5', reasoning: true, input: ['text'] },
]

async function settingsRoot(): Promise<Settings> {
  process.env.PI_CONFIG_DIR = tempDir()
  return await Settings.init()
}

/*
 * 草稿控件表（方案 §04）。这里是它**组装规则**的单测：注册表给了什么、白名单滤掉什么、
 * 没有默认模型时怎么办。真引擎那一侧的端到端在 engine-testkit 的 C-DRAFT-CONTROLS。
 */
describe('draftControlsOf', () => {
  test('默认姿态是 auto-edit，planMode / goal / context 都是空值', async () => {
    const controls = draftControlsOf({
      registry: registryOf(MODELS),
      root: await settingsRoot(),
      current: null,
      posture: 'auto-edit',
      thinking: null,
    })

    expect(controls.posture).toBe('auto-edit')
    expect(controls.planMode).toBe(false)
    expect(controls.goal).toBeNull()
    expect(controls.context).toBeNull()
  })

  test('模型清单来自注册表，reasoning / images 逐条照抄', async () => {
    const controls = draftControlsOf({
      registry: registryOf(MODELS),
      root: await settingsRoot(),
      current: null,
      posture: 'auto-edit',
      thinking: null,
    })

    expect(controls.model.choices.map((c) => `${c.ref.provider}/${c.ref.id}`)).toEqual([
      'anthropic/claude-opus-4-5',
      'openai/gpt-5',
    ])
    expect(controls.model.choices[0]?.reasoning).toBe(true)
    expect(controls.model.choices[0]?.images).toBe(true)
    expect(controls.model.choices[1]?.images).toBe(false)
  })

  /*
   * 真实故障（产品负责人 2026-10-06 的截图）：输入框那一排**没有模型选择**。
   *
   * 根因是 `model.current` 为 null（新装机器上 modelRoles.default 还没被谁写过），
   * 胶囊里模型名渲染成空字符串 → 那颗按钮宽度塌成 0，视觉上就不存在。
   *
   * 所以「没给默认模型」时必须报出**目录里第一条可用的** —— 那条会话真跑起来时 SDK
   * 自己也会挑一条，报出它才是诚实的。
   */
  test('没有默认模型时，current 取目录里第一条可用模型（胶囊才画得出来）', async () => {
    const controls = draftControlsOf({
      registry: registryOf(MODELS),
      root: await settingsRoot(),
      current: null,
      posture: 'auto-edit',
      thinking: null,
    })

    expect(controls.model.current).toEqual({ provider: 'anthropic', id: 'claude-opus-4-5' })
  })

  test('目录为空时 current 仍是 null（没有可报的，不编一条）', async () => {
    const controls = draftControlsOf({
      registry: registryOf([]),
      root: await settingsRoot(),
      current: null,
      posture: 'auto-edit',
      thinking: null,
    })

    expect(controls.model.current).toBeNull()
    expect(controls.model.choices).toEqual([])
  })

  test('显式给的 ref 优先，且目录里找不到时照原样报出去（不换成别的）', async () => {
    const controls = draftControlsOf({
      registry: registryOf(MODELS),
      root: await settingsRoot(),
      current: { provider: 'openai', id: 'gpt-5' },
      posture: 'auto-edit',
      thinking: null,
    })
    expect(controls.model.current).toEqual({ provider: 'openai', id: 'gpt-5' })

    /* 下架的 id：原样报，替用户换一条等于替他做了决定。 */
    const gone = draftControlsOf({
      registry: registryOf(MODELS),
      root: await settingsRoot(),
      current: { provider: 'openai', id: 'gpt-4-下架' },
      posture: 'auto-edit',
      thinking: null,
    })
    expect(gone.model.current).toEqual({ provider: 'openai', id: 'gpt-4-下架' })
  })

  test('思考档位按**当前模型**给；草稿给了就用草稿的', async () => {
    const auto = draftControlsOf({
      registry: registryOf(MODELS),
      root: await settingsRoot(),
      current: null,
      posture: 'auto-edit',
      thinking: null,
    })
    /* 第一条（anthropic）的梯子 + 它自己声明的默认档。 */
    expect(auto.thinking.choices.map((c) => c.id)).toEqual(['low', 'medium', 'high'])
    expect(auto.thinking.current).toBe('medium')

    const given = draftControlsOf({
      registry: registryOf(MODELS),
      root: await settingsRoot(),
      current: null,
      posture: 'auto-edit',
      thinking: 'high',
    })
    expect(given.thinking.current).toBe('high')

    /* 换成第二条（没有 thinking 那一格）时梯子是空的、默认档为 null —— 不编四档。 */
    const second = draftControlsOf({
      registry: registryOf(MODELS),
      root: await settingsRoot(),
      current: { provider: 'openai', id: 'gpt-5' },
      posture: 'auto-edit',
      thinking: null,
    })
    expect(second.thinking.choices).toEqual([])
    expect(second.thinking.current).toBeNull()
  })

  /*
   * 真机故障（用户报「模型卡片开始时没有思考强度，切换一次才正确显示」）：
   * DeepSeek 这类模型的目录里只有 `efforts`、**没有** `defaultLevel`，而 omp 建会话时
   * 会落到全局 `defaultThinkingLevel`（schema 默认 high）。此前草稿表在 defaultLevel
   * 缺席时报 null —— 入口页卡片上的档位一开始是空的。
   */
  test('模型没有声明 defaultLevel 时，档位退到全局 defaultThinkingLevel（与 omp 建会话同一条顺序）', async () => {
    const noDefault: readonly OmpModel[] = [
      {
        provider: 'deepseek',
        id: 'deepseek-flash',
        name: 'DeepSeek-V4.1-Flash',
        reasoning: true,
        input: ['text'],
        thinking: { efforts: ['low', 'high', 'max'] },
      },
    ]
    /* 没配过全局那一格：读出来的是 schema 默认 high。 */
    const controls = draftControlsOf({
      registry: registryOf(noDefault),
      root: await settingsRoot(),
      current: null,
      posture: 'auto-edit',
      thinking: null,
    })

    expect(controls.thinking.current).toBe('high')

    /* 显式配过的那一格优先于 schema 默认。 */
    const root = await settingsRoot()
    writeGlobalSetting(root, 'defaultThinkingLevel', 'max')
    const configured = draftControlsOf({
      registry: registryOf(noDefault),
      root,
      current: null,
      posture: 'auto-edit',
      thinking: null,
    })

    expect(configured.thinking.current).toBe('max')
  })

  test('全局默认档不在梯子上时按「没有这一档」处置（不报一个夹取后不存在的值）', async () => {
    const sparse: readonly OmpModel[] = [
      {
        provider: 'deepseek',
        id: 'deepseek-flash',
        name: 'DeepSeek-V4.1-Flash',
        reasoning: true,
        thinking: { efforts: ['low', 'max'] },
      },
    ]
    const root = await settingsRoot()
    writeGlobalSetting(root, 'defaultThinkingLevel', 'high')
    const controls = draftControlsOf({
      registry: registryOf(sparse),
      root,
      current: null,
      posture: 'auto-edit',
      thinking: null,
    })

    expect(controls.thinking.current).toBeNull()
  })

  test('enabledModels 白名单滤掉停用的模型', async () => {
    const root = await settingsRoot()
    /* 与 models.test.ts 同一套写入面（settings-access 的句柄）。 */
    writeGlobalSetting(root, 'enabledModels', ['openai/gpt-5'])
    const controls = draftControlsOf({
      registry: registryOf(MODELS),
      root,
      current: null,
      posture: 'auto-edit',
      thinking: null,
    })

    expect(controls.model.choices.map((c) => `${c.ref.provider}/${c.ref.id}`)).toEqual(['openai/gpt-5'])
    /* 第一条可用的也要跟着白名单走。 */
    expect(controls.model.current).toEqual({ provider: 'openai', id: 'gpt-5' })
  })
})
