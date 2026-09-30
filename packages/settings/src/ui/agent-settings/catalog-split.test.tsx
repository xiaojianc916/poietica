import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  type AgentSettingEntry,
  type AgentSettingsCatalog,
  type AgentSettingsPort,
  AgentSettingsStore,
} from '../../index'
import { AgentSettingsSectionPage as SectionPage } from './agent-settings'

/*
 * 条数验收：构造一份**合成**目录，核对两页各画几行。
 *
 * 这一份输入是我们自己造的样本，不是线上真实目录。桥侧的 readCatalog 会先滤掉与桌面端无关的
 * 终端类格子（`irrelevantSettingOf`），所以 UI 侧拿到的格子数少于 agent 自报的总数；真实条数
 * 由桥那一侧的测试守着。这里钉的是**关系**：两页行数等于各自归属的格子数，且两页互斥。
 * 上游加一格，这个等式照样成立，不必回来改夹具。
 */

/*
 * 记忆与个性化那两段的样本路径，条数取实测（omp 18.3.0）：记忆 30 格、个性化 16 格。
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

/** 服务档位：与人设同组，但属于成本/路由，**不归个性化页**。 */
const TIER_PATHS = ['tier.openai', 'tier.anthropic', 'tier.google', 'tier.subagent', 'tier.advisor']

function entry(path: string, section?: 'memory' | 'persona'): AgentSettingEntry {
  return {
    path,
    type: 'string',
    label: `L ${path}`,
    description: `D ${path}`,
    group: 'G',
    default: null,
    value: 'v',
    secret: false,
    hasValue: false,
    ...(section === undefined ? {} : { section }),
  }
}

/** 合成目录：30 记忆 + 16 个性化 + 几个无归属的（含 tier）。 */
function syntheticCatalog(): AgentSettingsCatalog {
  const settings: AgentSettingEntry[] = []

  for (const path of MEMORY_PATHS) {
    settings.push(entry(path, 'memory'))
  }
  for (const path of PERSONA_PATHS) {
    settings.push(entry(path, 'persona'))
  }
  for (const path of TIER_PATHS) {
    settings.push(entry(path))
  }

  return { settings }
}

function storeOf(catalog: AgentSettingsCatalog): AgentSettingsStore {
  const port: AgentSettingsPort = {
    read: () => Promise.resolve(catalog),
    write: () => Promise.resolve(catalog.settings),
  }

  return new AgentSettingsStore(port)
}

function rows(markup: string): number {
  return (markup.match(/class="settings-row"/g) ?? []).length
}

async function renderSynthetic(section: 'memory' | 'persona'): Promise<string> {
  const store = storeOf(syntheticCatalog())
  await store.load()

  return renderToStaticMarkup(<SectionPage section={section} store={store} />)
}

describe('两页的条数关系', () => {
  it('记忆页画 30 行、个性化页画 16 行', async () => {
    const memory = rows(await renderSynthetic('memory'))
    const persona = rows(await renderSynthetic('persona'))

    expect(memory).toBe(MEMORY_PATHS.length)
    expect(persona).toBe(PERSONA_PATHS.length)
  })

  /*
   * 服务档位不属于人设：它们不归个性化页。这一条是「同组不等于同页」的判据 ——
   * 分组（`group`）与归属（`section`）是两件事。
   */
  it('服务档位不在个性化页', async () => {
    const persona = await renderSynthetic('persona')

    for (const path of TIER_PATHS) {
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
