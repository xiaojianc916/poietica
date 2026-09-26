import { beforeEach, describe, expect, it, mock } from 'bun:test'
import * as contract from '@poietica/contract'
import type { AgentSettingsCatalogWire } from '@poietica/contract/settings'

/*
 * 传输口这一层的判据：线上形状（可缺席格是 null）与领域形状（可缺席格是 undefined）的
 * 对齐，以及写的那条路上值原样出去。
 *
 * 打桩打在**生成的命令**上（端口自己的下界），不重写桥：桥那一侧的形状由
 * packages/agent-bridge 的测试守着，这里守的是这一层翻译有没有把 null 漏成 undefined。
 * 桩里把真模块的其余出口原样散回去 —— bun 的模块桩是**进程级**的，只换 commands
 * 会让同一次运行里别的测试文件连 events 都 import 不到。
 *
 * 自检跑法：bun test src/agent/settings.test.ts
 */

/*
 * 桩的返回类型写宽：mock() 会从第一次实现里推死返回类型，而下面每个用例换一份实现。
 * 写清签名是为了让「换一份实现」不被类型挡住，不是为了让桩更通用。
 */
const agentSettingsCatalog = mock((...args: unknown[]): Promise<AgentSettingsCatalogWire> => {
  void args
  return Promise.resolve({ tabs: [], settings: [], configFile: '', configFileExists: false })
})
const agentSetSetting = mock(
  (...args: unknown[]): Promise<AgentSettingsCatalogWire['settings']> => {
    void args
    return Promise.resolve([])
  },
)

mock.module('@poietica/contract', () => ({
  ...contract,
  commands: { ...contract.commands, agentSettingsCatalog, agentSetSetting },
}))

const { createAgentSettingsPort } = await import('./settings')
const { catalogOf } = await import('@poietica/settings')

/** 一格线上元数据：可缺席的格一律 null（Rust 的 Option::None 到这边就是 null）。 */
const wire: AgentSettingsCatalogWire = {
  tabs: [
    { key: 'memory', label: '记忆' },
    { key: 'tools', label: '工具' },
  ],
  configFile: '/home/config.yml',
  configFileExists: true,
  settings: [
    {
      path: 'browser.headless',
      type: 'boolean',
      label: 'Headless',
      description: 'Run without a window',
      tab: 'tools',
      group: null,
      default: false,
      value: true,
      secret: false,
      hasValue: false,
      options: null,
      enumValues: null,
      warning: null,
      condition: null,
      groupLabel: null,
      owned: false,
    },
    {
      path: 'mnemopi.llmApiKey',
      type: 'string',
      label: 'LLM API Key',
      description: '',
      tab: 'memory',
      group: 'Mnemopi',
      default: null,
      /* 线上就是 null：钥匙的值不出 agent 的进程。 */
      value: null,
      secret: true,
      hasValue: true,
      options: null,
      enumValues: null,
      warning: null,
      condition: 'mnemopiActive',
      groupLabel: null,
      owned: false,
    },
    {
      path: 'sleep.prevention',
      type: 'enum',
      label: 'Sleep prevention',
      description: '',
      tab: 'tools',
      group: 'Power',
      default: 'idle',
      value: 'idle',
      secret: false,
      hasValue: false,
      options: [
        { value: 'off', label: 'Off', description: null },
        { value: 'idle', label: 'Prevent Idle', description: 'caffeinate -i' },
      ],
      enumValues: null,
      warning: null,
      condition: null,
      groupLabel: null,
      owned: false,
    },
  ],
}

describe('agent 设置目录的传输口', () => {
  beforeEach(() => {
    agentSettingsCatalog.mockClear()
    agentSetSetting.mockClear()
  })

  it('null 译成 undefined：可缺席的格在领域侧就是缺席，不是「有个 null 值」', async () => {
    agentSettingsCatalog.mockImplementation(() => Promise.resolve(wire))

    const catalog = await createAgentSettingsPort().read()

    /* 栏是键与名成对的：键给筛选认，名给人看。 */
    expect(catalog.tabs).toEqual([
      { key: 'memory', label: '记忆' },
      { key: 'tools', label: '工具' },
    ])

    const headless = catalog.settings[0]

    /* group: null 在领域侧是「没有这一格」，不是「这一格是 null」。 */
    expect(headless?.group).toBeUndefined()
    expect(headless?.options).toBeUndefined()
    expect(headless?.warning).toBeUndefined()
    expect(headless?.condition).toBeUndefined()
    /* 有值的那几格原样搬。 */
    expect(headless?.value).toBe(true)
    expect(headless?.default).toBe(false)
  })

  it('选项表带着说法原样搬，缺席的说法不编一个空串', async () => {
    agentSettingsCatalog.mockImplementation(() => Promise.resolve(wire))

    const catalog = await createAgentSettingsPort().read()
    const offered = catalog.settings[2]?.options

    expect(offered).toHaveLength(2)
    expect(offered?.[0]?.description).toBeUndefined()
    expect(offered?.[1]?.description).toBe('caffeinate -i')
  })

  /*
   * 钥匙那一格：这一层只搬「是不是钥匙」与「配过没有」。
   * 值那一格线上本来就是 null，所以这里能断言的是它**没有被填回来**。
   */
  it('钥匙那一格：只有 is 与 hasValue 过线，值仍然是空', async () => {
    agentSettingsCatalog.mockImplementation(() => Promise.resolve(wire))

    const secret = (await createAgentSettingsPort().read()).settings.find(
      (candidate) => candidate.path === 'mnemopi.llmApiKey',
    )

    expect(secret?.secret).toBe(true)
    expect(secret?.hasValue).toBe(true)
    expect(secret?.value).toBeNull()
    expect(secret?.condition).toBe('mnemopiActive')
  })

  it('写把路径与值原样交给命令，交回的格子译成领域形状', async () => {
    /* 取那一格用 find 而不是下标：noUncheckedIndexedAccess 下下标是「可能没有」，不是「一定在」。 */
    const credential = wire.settings.find((entry) => entry.path === 'mnemopi.llmApiKey')

    agentSetSetting.mockImplementation((args: unknown) => {
      void args
      return Promise.resolve(credential === undefined ? [] : [credential])
    })

    const settings = await createAgentSettingsPort().write('mnemopi.llmApiKey', 'sk-new')

    expect(agentSetSetting).toHaveBeenCalledWith({ path: 'mnemopi.llmApiKey', value: 'sk-new' })
    expect(settings[0]?.path).toBe('mnemopi.llmApiKey')
    expect(settings[0]?.secret).toBe(true)
    expect(settings[0]?.hasValue).toBe(true)
  })

  it('非字符串的值也原样出去：类型由 agent 自己的 schema 说了算，这一层不折算', async () => {
    agentSetSetting.mockImplementation(() => Promise.resolve([]))

    await createAgentSettingsPort().write('compaction.thresholdPercent', 75)

    expect(agentSetSetting).toHaveBeenCalledWith({ path: 'compaction.thresholdPercent', value: 75 })
  })
})

/* 这一层是纯翻译：同一个 wire 过 catalogOf 两次，形状必须一致（没有随机或时序成分）。 */
describe('catalogOf', () => {
  it('同一份线上形状译两次结果相同', () => {
    expect(catalogOf(wire)).toEqual(catalogOf(wire))
  })
})
