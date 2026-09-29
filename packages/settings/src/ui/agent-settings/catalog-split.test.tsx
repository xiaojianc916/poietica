import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  type AgentSettingEntry,
  type AgentSettingsCatalog,
  type AgentSettingsPort,
  AgentSettingsStore,
} from '../../index'
import {
  AgentSettingsSectionPage as SectionPage,
  AgentSettingsCatalog as Surface,
} from './agent-settings'

/*
 * 条数验收：构造一份**合成**目录，核对三页各画几行。
 *
 * 这一份输入是我们自己造的样本，不是线上真实目录。桥侧的 readCatalog 会先滤掉与桌面端无关的
 * 终端类格子（`irrelevantSettingOf`），所以 UI 侧拿到的格子数少于 agent 自报的总数；真实条数
 * 由桥那一侧的测试守着。这里钉的是**关系**：三页行数之和等于目录里可画的格子数，且两页互斥。
 * 上游加一格，这个等式照样成立，不必回来改夹具。
 */

/*
 * 记忆与人设那两段的样本路径，条数取实测（omp 18.3.0）：记忆 30 格、人设 16 格。
 *
 * 只求**条数与归属正确**，不求逐个路径名与上游一致 —— 那是桥那一侧分类测试的活。
 */
const MEMORY_PATHS = [
  'memory.backend',
  ...Array.from({ length: 16 }, (_, index) => `mnemopi.${String(index)}`),
  ...Array.from({ length: 10 }, (_, index) => `hindsight.${String(index)}`),
  ...Array.from({ length: 2 }, (_, index) => `autolearn.${String(index)}`),
  'sharpshooter.model',
]

const PERSONA_PATHS = [
  'personality',
  'skillful',
  'includeModelInPrompt',
  'includeWorkspaceTree',
  'inlineToolDescriptors',
  'modelRoleStorage',
  'omitThinking',
  'externalThinking',
  'providers.autoThinkingMaxEffort',
  'temperature',
  'topP',
  'topK',
  'minP',
  'presencePenalty',
  'repetitionPenalty',
  'textVerbosity',
]

/*
 * 无归属格子的条数。这是**构造**这个夹具用的填充量，不是线上任何一处的真实条数 ——
 * 只为让「三页之和 = 目录格数」这条等式在一个有规模的目录上被验一次。
 */
const PLAIN_COUNT = 332

/** 服务档位：与人设同组，但属于成本/路由，**留在 Agent 设置页**。 */
const TIER_PATHS = ['tier.openai', 'tier.anthropic', 'tier.google', 'tier.subagent', 'tier.advisor']

function entry(path: string, tab: string, section?: 'memory' | 'persona'): AgentSettingEntry {
  return {
    path,
    type: 'string',
    label: `L ${path}`,
    description: `D ${path}`,
    tab,
    group: 'G',
    default: null,
    value: 'v',
    secret: false,
    hasValue: false,
    ...(section === undefined ? {} : { section }),
  }
}

/*
 * 全部格子放在**同一栏**里。
 *
 * 不是图省事：Agent 设置页默认只画当前那一栏（`tabs` 的第一栏），跨栏的格子不进首屏。
 * 这里要数的是「这一页总共画了多少格」，同栏才数得准；栏的行为另有测试守着
 * （agent-settings.test.tsx 的「导航跟着目录报的 tabs 走」）。
 */
const TAB = 'tools'

/** 合成目录：332 无归属 + 30 记忆 + 16 人设（外加 5 个 tier 也算无归属）。 */
function syntheticCatalog(): AgentSettingsCatalog {
  const settings: AgentSettingEntry[] = []

  for (let index = 0; index < PLAIN_COUNT; index += 1) {
    settings.push(entry(`plain.${String(index)}`, TAB))
  }
  for (const path of MEMORY_PATHS) {
    settings.push(entry(path, TAB, 'memory'))
  }
  for (const path of PERSONA_PATHS) {
    settings.push(entry(path, TAB, 'persona'))
  }
  for (const path of TIER_PATHS) {
    settings.push(entry(path, TAB))
  }

  return {
    tabs: [{ key: TAB, label: '工具' }],
    settings,
    configFile: '/home/config.yml',
    configFileExists: true,
  }
}

function storeOf(catalog: AgentSettingsCatalog): AgentSettingsStore {
  const port: AgentSettingsPort = {
    read: () => Promise.resolve(catalog),
    write: () => Promise.resolve(catalog.settings),
    openConfigFile: () => Promise.resolve(),
  }

  return new AgentSettingsStore(port)
}

function rows(markup: string): number {
  return (markup.match(/class="settings-row"/g) ?? []).length
}

async function renderSynthetic(section: 'memory' | 'persona' | null): Promise<string> {
  const store = storeOf(syntheticCatalog())
  await store.load()

  return section === null
    ? renderToStaticMarkup(<Surface store={store} />)
    : renderToStaticMarkup(<SectionPage section={section} store={store} />)
}

describe('三页的条数关系', () => {
  it('记忆页画 30 行、人设页画 16 行、Agent 设置页画其余全部 + 它的两条入口', async () => {
    const memory = rows(await renderSynthetic('memory'))
    const persona = rows(await renderSynthetic('persona'))
    const main = rows(await renderSynthetic(null))

    expect(memory).toBe(MEMORY_PATHS.length)
    expect(persona).toBe(PERSONA_PATHS.length)
    /* 这一页画的是无归属的那些，外加两条入口行（搜索框与开配置文件）。 */
    expect(main).toBe(PLAIN_COUNT + TIER_PATHS.length + 2)
    /* 守恒：三页之和（减去两条入口行）等于目录里全部格子。 */
    expect(memory + persona + main - 2).toBe(
      PLAIN_COUNT + TIER_PATHS.length + MEMORY_PATHS.length + PERSONA_PATHS.length,
    )
  })

  /*
   * 服务档位不属于人设：它们留在 Agent 设置页，一格都不许出现在人设页。
   * 这一条是「同组不等于同页」的判据 —— 分组（`group`）与归属（`section`）是两件事。
   */
  it('服务档位留在 Agent 设置页，不在人设页', async () => {
    const main = await renderSynthetic(null)
    const persona = await renderSynthetic('persona')

    for (const path of TIER_PATHS) {
      expect(main).toContain(`L ${path}`)
      expect(persona).not.toContain(`L ${path}`)
    }
  })

  it('两页互斥：记忆页上没有人设的格子，反之亦然', async () => {
    const memory = await renderSynthetic('memory')
    const persona = await renderSynthetic('persona')

    expect(memory).toContain('L memory.backend')
    expect(memory).not.toContain('L personality')
    expect(persona).toContain('L personality')
    expect(persona).not.toContain('L memory.backend')
  })
})
