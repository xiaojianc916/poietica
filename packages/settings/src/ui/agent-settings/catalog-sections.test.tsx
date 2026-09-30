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
 * 两页各画自己那一段的判据：同一份目录里，每一格**至多只有一个**页面画它的行。
 *
 * 三件事各自独立：
 *   1. 记忆页只画 `section === 'memory'` 的格子，个性化页只画 `section === 'persona'` 的。
 *   2. 没有归属的格子两页都不画（产品没有它们的位置）。
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
    group: 'Group',
    default: null,
    value: true,
    secret: false,
    hasValue: false,
    ...overrides,
  }
}

/*
 * 三类格子各来几格：记忆、人设，以及两页都不归属的那些。
 *
 * 三类的 `label` 前缀不同，这样「某一页画了哪个」可以直接从 markup 里读出来，
 * 不必靠数行数猜。
 */
function mixedCatalog(): AgentSettingsCatalog {
  return {
    settings: [
      entry('tools.plain', { label: 'Plain tool' }),
      entry('tools.other', { label: 'Other tool' }),
      entry('memory.backend', {
        label: 'Memory backend',
        type: 'enum',
        value: 'off',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'hindsight', label: 'Hindsight' },
        ],
      }),
      entry('mnemopi.model', { label: 'Mnemopi model', type: 'string', value: 'x' }),
      entry('personality', { label: 'Personality', type: 'string', value: 'default' }),
      entry('externalThinking', { label: 'External thinking', type: 'boolean', value: true }),
    ],
  }
}

function storeOf(catalog: AgentSettingsCatalog): AgentSettingsStore {
  const port: AgentSettingsPort = {
    read: () => Promise.resolve(catalog),
    write: () => Promise.resolve(catalog.settings),
  }

  return new AgentSettingsStore(port)
}

/** 归属已标好的目录：两类格子带 section，其余不带。 */
function separatedCatalog(): AgentSettingsCatalog {
  const catalog = mixedCatalog()

  return {
    settings: catalog.settings.map((item) =>
      item.path.startsWith('memory.') || item.path.startsWith('mnemopi.')
        ? { ...item, section: 'memory' as const }
        : item.path === 'personality' || item.path === 'externalThinking'
          ? { ...item, section: 'persona' as const }
          : item,
    ),
  }
}

async function render(
  catalog: AgentSettingsCatalog,
  section: 'memory' | 'persona',
): Promise<string> {
  const store = storeOf(catalog)
  await store.load()

  return renderToStaticMarkup(<SectionPage section={section} store={store} />)
}

describe('记忆页与个性化页', () => {
  it('记忆页只画归属记忆的格子', async () => {
    const markup = await render(separatedCatalog(), 'memory')

    expect(markup).toContain('Memory backend')
    expect(markup).toContain('Mnemopi model')
    /* 没有归属的格子与另一页的格子都不许出现在这一页。 */
    expect(markup).not.toContain('Plain tool')
    expect(markup).not.toContain('Personality')
  })

  it('个性化页只画归属人设的格子', async () => {
    const markup = await render(separatedCatalog(), 'persona')

    expect(markup).toContain('Personality')
    expect(markup).toContain('External thinking')
    expect(markup).not.toContain('Memory backend')
    expect(markup).not.toContain('Plain tool')
  })

  it('两页都渲染得出来，不抛', async () => {
    const catalog = separatedCatalog()

    expect(await render(catalog, 'memory')).toContain('settings-page')
    expect(await render(catalog, 'persona')).toContain('settings-page')
  })

  /*
   * 选项那一行只画名字，不画上游那句说明。
   *
   * 触发器与弹层读的是同一份选项表（design-system 的 Select 只有一个产地），所以拿
   * 选中的那一项来钉：说明一旦被拼进 label，它就会出现在触发器上。
   */
  it('选项行只画名字，不把说明拼进去', async () => {
    const catalog: AgentSettingsCatalog = {
      settings: [
        entry('memory.backend', {
          label: '记忆后端',
          section: 'memory',
          type: 'enum',
          value: 'hindsight',
          options: [
            { value: 'hindsight', label: 'Hindsight 远程记忆', description: '一句很长的上游说明' },
          ],
        }),
      ],
    }

    const markup = await render(catalog, 'memory')

    expect(markup).toContain('Hindsight 远程记忆')
    expect(markup).not.toContain('一句很长的上游说明')
    /* 值那一格不进画面：它是写回 agent 的标识，不是给人看的字。 */
    expect(markup).not.toContain('hindsight</span>')
  })

  /*
   * 空态是防御性的：上游此刻给这两栏 30 / 10 格，正常取不到空。这里造一份没有这一类的
   * 目录来证明它确实有话可说 —— 一片空白会让人以为自己的设置丢了。
   */
  it('一条都没有时画空态，不是一片空白', async () => {
    const empty: AgentSettingsCatalog = {
      settings: [entry('tools.plain', { label: 'Plain tool' })],
    }

    const memory = await render(empty, 'memory')
    const persona = await render(empty, 'persona')

    expect(memory).toContain('agent 没有报出这一类设置')
    expect(memory).not.toContain('Plain tool')
    expect(persona).toContain('agent 没有报出这一类设置')
    expect(persona).not.toContain('Plain tool')
  })

  /*
   * `owned` 与 `section` 正交：一行由别处控件负责时，那一页也不画它的行 ——
   * 但它的值还在，别的格子的 `condition` 照常读得到它。
   */
  it('owned 的格子不画它的行', async () => {
    const catalog: AgentSettingsCatalog = {
      settings: [
        entry('personality', { label: 'Personality', section: 'persona' }),
        entry('defaultThinkingLevel', {
          label: 'Thinking level',
          section: 'persona',
          owned: true,
        }),
      ],
    }

    const markup = await render(catalog, 'persona')

    expect(markup).toContain('Personality')
    expect(markup).not.toContain('Thinking level')
  })

  /*
   * 记忆页可见性条件读的是**整份目录**，不是筛完的那一段：`hindsightActive` 要读
   * `memory.backend` 此刻的值，而那一格正好在同一页上。
   */
  it('记忆页的条件按整份目录里此刻的值求值', async () => {
    const catalog = (backend: string): AgentSettingsCatalog => ({
      settings: [
        entry('memory.backend', {
          label: 'Memory backend',
          section: 'memory',
          type: 'enum',
          value: backend,
        }),
        entry('hindsight.llmModel', {
          label: 'Hindsight model',
          section: 'memory',
          condition: 'hindsightActive',
        }),
      ],
    })

    const off = await render(catalog('mnemopi'), 'memory')
    expect(off).toContain('Memory backend')
    expect(off).not.toContain('Hindsight model')

    const on = await render(catalog('hindsight'), 'memory')
    expect(on).toContain('Hindsight model')
  })
})
