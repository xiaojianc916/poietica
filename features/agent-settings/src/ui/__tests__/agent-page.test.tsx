import { describe, expect, test } from 'bun:test'
import { cleanup, render as mount, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import type { SettingDescriptor, SettingGroup } from '../../contract'
import { AgentPage } from '../agent-page'
import type { AgentSettingsApi } from '../api'

/*
 * 记忆页与个性化页各画自己那一段：同一份目录里，每一格**至多只有一个**页面画它的行。
 *
 * 这一份测试钉的正是修掉的那个缺陷：归属曾经由界面按**组名里的关键词**猜
 * （`/persona|个性|性格/`），而组名在引擎端口那头已经译成了中文（「提示词」「思考」），
 * 一个都匹配不上 —— 个性化页于是只剩空白，记忆页则把整份目录画了出来。
 *
 * 现在归属是**引擎报的**（`descriptor.section`），界面只做等值比较。
 */

function descriptor(over: Partial<SettingDescriptor> & { readonly path: string }): SettingDescriptor {
  return {
    group: 'G',
    groupLabel: 'G',
    label: `L ${over.path}`,
    description: `D ${over.path}`,
    type: 'string',
    options: null,
    value: 'v',
    defaultValue: null,
    warning: null,
    condition: null,
    owned: false,
    section: null,
    secret: false,
    hasValue: false,
    ...over,
  }
}

/** 目录 → 分组（按 group 键归并，保序）：与服务层同一套规则的精简版。 */
function group(settings: readonly SettingDescriptor[]): SettingGroup[] {
  const byId = new Map<string, SettingGroup>()
  for (const s of settings) {
    const existing = byId.get(s.group)
    if (existing === undefined) byId.set(s.group, { id: s.group, label: s.groupLabel, settings: [s] })
    else existing.settings.push(s)
  }
  return [...byId.values()]
}

function apiOf(groups: readonly SettingGroup[]): AgentSettingsApi {
  return {
    catalog: async () => ({ groups: [...groups] }),
    set: async (path, value) => descriptor({ path, value, group: 'G', groupLabel: 'G' }) as SettingDescriptor,
    reset: async (path) => descriptor({ path }),
    capabilities: async () => ({ computerUse: false, browserControl: false }),
    setCapability: async () => ({ computerUse: false, browserControl: false }),
    onChanged: () => ({ dispose: () => undefined }),
  } as AgentSettingsApi
}

/** 画一页并等目录到达（catalog 是异步的，加载态那一帧没有行）。 */
async function render(settings: readonly SettingDescriptor[], section: 'memory' | 'persona'): Promise<HTMLElement> {
  cleanup()
  const { container } = mount(createElement(AgentPage, { api: apiOf(group(settings)), section }))
  await waitFor(() => {
    expect(container.querySelector('.settings-state')).toBeNull()
  })
  return container
}

function rows(container: HTMLElement): number {
  return container.querySelectorAll('.settings-row').length
}

/** 页面上出现的行标签（强元素的文本），用来断言「画了哪几格」。 */
function labels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.settings-row__copy > strong')].map((el) => el.textContent ?? '')
}

describe('记忆页与个性化页的拆分', () => {
  /*
   * 合成目录：3 记忆 + 2 个性化 + 2 无归属。条数只求**关系**正确
   * （两页行数等于各自归属的格子数），不逐个路径与上游对齐 —— 那是引擎端口那一侧的活。
   */
  const settings: readonly SettingDescriptor[] = [
    descriptor({ path: 'memory.backend', section: 'memory', group: 'General', groupLabel: '通用' }),
    descriptor({ path: 'mnemopi.bank', section: 'memory', group: 'Mnemopi' }),
    descriptor({ path: 'hindsight.apiUrl', section: 'memory', group: 'Hindsight' }),
    descriptor({ path: 'personality', section: 'persona', group: 'Prompt', groupLabel: '提示词' }),
    descriptor({ path: 'omitThinking', section: 'persona', group: 'Thinking', groupLabel: '思考' }),
    descriptor({ path: 'compaction.enabled', group: 'Compaction' }),
    descriptor({ path: 'temperature', group: 'Sampling' }),
  ]

  test('记忆页只画归属记忆的格子', async () => {
    const page = await render(settings, 'memory')
    expect(rows(page)).toBe(3)
    expect(labels(page)).toContain('L memory.backend')
    expect(labels(page)).not.toContain('L personality')
    expect(labels(page)).not.toContain('L compaction.enabled')
  })

  test('个性化页只画归属人设的格子', async () => {
    const page = await render(settings, 'persona')
    expect(rows(page)).toBe(2)
    expect(labels(page)).toContain('L personality')
    expect(labels(page)).toContain('L omitThinking')
    expect(labels(page)).not.toContain('L memory.backend')
  })

  /*
   * 组标题取 `groupLabel`（中文）而不是 `group`（omp 的键）——
   * 归并用键、上屏用译名，两者不是一件事。
   */
  test('组标题用 groupLabel，归并仍按 group 键', async () => {
    const page = await render(settings, 'persona')
    const titles = [...page.querySelectorAll('.settings-group__header h3')].map((el) => el.textContent)
    expect(titles).toEqual(['提示词', '思考'])
    expect(titles).not.toContain('Prompt')
  })

  /* 一组里所有行都被滤掉时整个不画 —— 空标题下面什么都没有只是在说「这里本来有话」。 */
  test('行被滤空的组不画出来', async () => {
    const page = await render(
      [descriptor({ path: 'brand.new', section: 'memory', group: 'Hindsight', groupLabel: 'Hindsight' })],
      'memory',
    )
    expect(rows(page)).toBe(1)
    expect([...page.querySelectorAll('.settings-group__header h3')].map((el) => el.textContent)).toEqual(['Hindsight'])
  })

  test('一条都没有时画空态，不是一片空白', async () => {
    const only = [descriptor({ path: 'compaction.enabled', group: 'Compaction' })]
    expect((await render(only, 'memory')).textContent).toContain('agent 没有报出这一类设置')
    expect((await render(only, 'persona')).textContent).toContain('agent 没有报出这一类设置')
  })
})

describe('owned 与 condition', () => {
  /*
   * `owned` 的格子不画行：它的**行**由产品别处的控件负责，画第二遍就是一个事实两个控件。
   * 但它的值仍在目录里 —— 别的格子按 `condition` 读它。
   */
  test('owned 的格子不画行', async () => {
    const page = await render(
      [
        descriptor({ path: 'personality', section: 'persona' }),
        descriptor({ path: 'defaultThinkingLevel', section: 'persona', owned: true }),
      ],
      'persona',
    )
    expect(labels(page)).toEqual(['L personality'])
  })

  /*
   * 条件按**整份目录**里此刻的值求值，不是筛完的那一段：
   * `mnemopiActive` 要读 `memory.backend`，而那一格正好在同一页上。
   */
  test('条件按整份目录里此刻的值求值', async () => {
    const catalog = (backend: string): readonly SettingDescriptor[] => [
      descriptor({ path: 'memory.backend', section: 'memory', value: backend }),
      descriptor({ path: 'mnemopi.bank', section: 'memory', condition: 'mnemopiActive' }),
    ]

    const off = await render(catalog('hindsight'), 'memory')
    expect(labels(off)).toEqual(['L memory.backend'])

    const on = await render(catalog('mnemopi'), 'memory')
    expect(labels(on)).toEqual(['L memory.backend', 'L mnemopi.bank'])
  })

  /* 认不出的条件名一律不显示：少显示一格人看得出，多显示一格人看不出。 */
  test('认不出的条件名不显示那一行', async () => {
    const page = await render(
      [descriptor({ path: 'mystery', section: 'memory', condition: 'nobodyKnowsThis' })],
      'memory',
    )
    /* 只剩空态那一行（它自己也是一行，所以按标签而不是按行数判）。 */
    expect(labels(page)).toEqual(['无可显示的项'])
    expect(page.textContent).toContain('agent 没有报出这一类设置')
  })
})

describe('风险提示与选项', () => {
  /* 风险提示原样上屏，排在说明之上（与 legacy 的 SettingRow 同一格）。 */
  test('warning 原样上屏', async () => {
    const page = await render(
      [descriptor({ path: 'externalThinking', section: 'persona', warning: '会被供应商标记为滥用' })],
      'persona',
    )
    expect(screen.getByRole('alert').textContent).toBe('会被供应商标记为滥用')
    expect(page.querySelector('.settings-row__warning')).not.toBeNull()
  })

  /*
   * 选项行只画 `label`（中文），`value` 是写回 agent 的标识符、不进画面；
   * 上游那句 `description` 也不拼进 label（下拉每一行会被撑成一堆半截话）。
   */
  test('选项画中文 label，不画标识符与上游长说明', async () => {
    const page = await render(
      [
        descriptor({
          path: 'memory.backend',
          section: 'memory',
          type: 'enum',
          value: 'hindsight',
          options: [
            {
              value: 'hindsight',
              label: 'Hindsight 远程记忆',
              description: '一句很长的上游说明',
            },
          ],
        }),
      ],
      'memory',
    )
    /* 触发器上显示的是中文 label，不是写回 agent 的标识符。 */
    expect(page.textContent).toContain('Hindsight 远程记忆')
    /* 上游那句长说明不拼进 label（下拉每一行会被撑成一堆半截话）。 */
    expect(page.textContent).not.toContain('一句很长的上游说明')
  })
})
