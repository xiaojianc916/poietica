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
 * 「只剥离，不删除」这一侧的判据：同一份目录里，每一格**有且只有一个**页面画它的行。
 *
 * 三件事各自独立：
 *   1. 记忆页只画 `section === 'memory'` 的格子，人设页只画 `section === 'persona'` 的。
 *   2. Agent 设置页这两类一格都不画（剥离），但它们**还在目录里**（没删）。
 *   3. 两页各自渲染不抛，且有话可说 —— 一条都没有时画空态，不是一片空白。
 *
 * 用 `section` 判据而不是路径前缀或栏名：那两样都是第二份分类表，上游多一格就静默分错。
 */

function entry(path: string, overrides: Partial<AgentSettingEntry> = {}): AgentSettingEntry {
  return {
    path,
    type: 'boolean',
    label: `Label ${path}`,
    description: `Description ${path}`,
    tab: 'tools',
    group: 'Group',
    default: null,
    value: true,
    secret: false,
    hasValue: false,
    ...overrides,
  }
}

/*
 * 三类格子各来几格：无归属（留在 Agent 设置页）、记忆、人设。
 *
 * 三类的 `label` 前缀不同，这样「某一页画了哪个」可以直接从 markup 里读出来，
 * 不必靠数行数猜。
 */
function mixedCatalog(): AgentSettingsCatalog {
  return {
    tabs: [
      { key: 'tools', label: '工具' },
      { key: 'model', label: '模型' },
    ],
    settings: [
      entry('tools.plain', { label: 'Plain tool', tab: 'tools' }),
      entry('tools.other', { label: 'Other tool', tab: 'tools' }),
      entry('memory.backend', {
        label: 'Memory backend',
        tab: 'memory',
        type: 'enum',
        value: 'off',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'hindsight', label: 'Hindsight' },
        ],
      }),
      entry('mnemopi.model', { label: 'Mnemopi model', tab: 'memory', type: 'string', value: 'x' }),
      entry('personality', {
        label: 'Personality',
        tab: 'model',
        type: 'string',
        value: 'default',
      }),
      entry('temperature', { label: 'Temperature', tab: 'model', type: 'number', value: 0.7 }),
    ],
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

/** 已剥离开启的目录：两类格子带 section，其余不带。 */
function separatedCatalog(): AgentSettingsCatalog {
  const catalog = mixedCatalog()

  return {
    ...catalog,
    settings: catalog.settings.map((item) =>
      item.path.startsWith('memory.') || item.path.startsWith('mnemopi.')
        ? { ...item, section: 'memory' as const }
        : item.path === 'personality' || item.path === 'temperature'
          ? { ...item, section: 'persona' as const }
          : item,
    ),
  }
}

async function render(
  catalog: AgentSettingsCatalog,
  section?: 'memory' | 'persona',
): Promise<string> {
  const store = storeOf(catalog)
  await store.load()

  return section === undefined
    ? renderToStaticMarkup(<Surface store={store} />)
    : renderToStaticMarkup(<SectionPage section={section} store={store} />)
}

describe('记忆页与人设与风格页', () => {
  it('记忆页只画归属记忆的格子', async () => {
    const markup = await render(separatedCatalog(), 'memory')

    expect(markup).toContain('Memory backend')
    expect(markup).toContain('Mnemopi model')
    /* 别的两类的格子一格都不许出现在这一页。 */
    expect(markup).not.toContain('Plain tool')
    expect(markup).not.toContain('Personality')
  })

  it('人设与风格页只画归属人设的格子', async () => {
    const markup = await render(separatedCatalog(), 'persona')

    expect(markup).toContain('Personality')
    expect(markup).toContain('Temperature')
    expect(markup).not.toContain('Memory backend')
    expect(markup).not.toContain('Plain tool')
  })

  /*
   * 剥离的判据：这两类**从 Agent 设置页消失**，但并没有从目录里删掉 ——
   * 同一个目录喂给两页，它们画得出来，说明是「换个地方画」而不是「不画了」。
   */
  it('Agent 设置页不再画这两类，而它们仍在目录里', async () => {
    const catalog = separatedCatalog()
    const main = await render(catalog)

    expect(main).toContain('Plain tool')
    expect(main).not.toContain('Memory backend')
    expect(main).not.toContain('Personality')

    expect(catalog.settings.some((item) => item.path === 'memory.backend')).toBe(true)
    expect(catalog.settings.some((item) => item.path === 'personality')).toBe(true)
  })

  /* 搜索也不许把它们捞回来：搜得到却点不进去，比搜不到更让人以为漏了东西。 */
  it('在 Agent 设置页搜得到词也不画它们的格子', async () => {
    const markup = await render(separatedCatalog())

    expect(markup).toContain('按名称或路径搜索…')
    expect(markup).not.toContain('Memory backend')
  })

  it('两页都渲染得出来，不抛', async () => {
    const catalog = separatedCatalog()

    expect(await render(catalog, 'memory')).toContain('settings-page')
    expect(await render(catalog, 'persona')).toContain('settings-page')
  })

  /*
   * 空态是防御性的：上游此刻给这两栏 30 / 17 格，正常取不到空。这里造一份没有这两类的
   * 目录来证明它确实有话可说 —— 一片空白会让人以为自己的设置丢了。
   */
  it('一条都没有时画空态，不是一片空白', async () => {
    const empty: AgentSettingsCatalog = {
      tabs: [{ key: 'tools', label: '工具' }],
      settings: [entry('tools.plain', { label: 'Plain tool' })],
      configFile: '/home/config.yml',
      configFileExists: true,
    }

    const memory = await render(empty, 'memory')
    const persona = await render(empty, 'persona')

    expect(memory).toContain('agent 没有报出这一类设置')
    expect(memory).not.toContain('Plain tool')
    expect(persona).toContain('agent 没有报出这一类设置')
    expect(persona).not.toContain('Plain tool')
  })

  /*
   * `owned` 与 `section` 正交：一行由别处控件负责时，两页都不画它的行 ——
   * 但它的值还在，别的格子的 `condition` 照常读得到它。
   */
  it('owned 的格子两页都不画它的行', async () => {
    const catalog: AgentSettingsCatalog = {
      tabs: [{ key: 'model', label: '模型' }],
      settings: [
        entry('personality', {
          label: 'Personality',
          tab: 'model',
          section: 'persona',
        }),
        entry('defaultThinkingLevel', {
          label: 'Thinking level',
          tab: 'model',
          section: 'persona',
          owned: true,
        }),
      ],
      configFile: '/home/config.yml',
      configFileExists: true,
    }

    const markup = await render(catalog, 'persona')

    expect(markup).toContain('Personality')
    expect(markup).not.toContain('Thinking level')
  })

  /*
   * 记忆页可见性条件读的是**整份目录**，不是筛完的那一段：`hindsightActive` 要读
   * `memory.backend` 此刻的值，而那一格正好在同一页上（这正是剥离后必须保证的）。
   */
  it('记忆页的条件按整份目录里此刻的值求值', async () => {
    const catalog = (backend: string): AgentSettingsCatalog => ({
      tabs: [{ key: 'memory', label: '记忆' }],
      settings: [
        entry('memory.backend', {
          label: 'Memory backend',
          tab: 'memory',
          section: 'memory',
          type: 'enum',
          value: backend,
        }),
        entry('hindsight.llmModel', {
          label: 'Hindsight model',
          tab: 'memory',
          section: 'memory',
          condition: 'hindsightActive',
        }),
      ],
      configFile: '/home/config.yml',
      configFileExists: true,
    })

    const off = await render(catalog('mnemopi'), 'memory')
    expect(off).toContain('Memory backend')
    expect(off).not.toContain('Hindsight model')

    const on = await render(catalog('hindsight'), 'memory')
    expect(on).toContain('Hindsight model')
  })
})
