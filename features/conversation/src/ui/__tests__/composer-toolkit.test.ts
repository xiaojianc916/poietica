import { describe, expect, test } from 'bun:test'
import type { ComposerToolkit, ComposerToolkitSource } from '../../ui-api'
import { composerPaletteGroups } from '../components/composer/composer-actions'
import { mergeToolkits, toolkitReaderOf } from '../configuration/composer-toolkit'

/*
 * 加号面板那两组（技能 / MCP）的数据合成。
 *
 * 这一份钉三件事：分组**有没有内容**（空名册就不画，面板里不该有按不动的组）、
 * 合并的形状（去重、次序、契约 → 面板的换算），以及 `read` 的**引用稳定性** ——
 * 它喂 useSyncExternalStore 的 getSnapshot，每次新造一张表会让整棵输入框无限重渲染。
 */

const empty: ComposerToolkit = { skills: [], mcpServers: [] }

function skill(name: string, description = `${name} 说明`): ComposerToolkit['skills'][number] {
  return { name, description, source: 'user' }
}

function server(name: string, state: ComposerToolkit['mcpServers'][number]['state'] = 'connected') {
  return { name, state, toolCount: 2, error: null }
}

describe('名册的合并', () => {
  test('没有来源就是空名册，两个分组都不画', () => {
    const toolkit = mergeToolkits([empty, empty])

    expect(toolkit.skills).toHaveLength(0)
    expect(toolkit.mcpServers).toHaveLength(0)
    /* 面板那一侧的判据：空表 -> 只剩「添加 / 模式」两组。 */
    expect(
      composerPaletteGroups({ controls: [], mcpServers: [], onSelectControl: () => undefined, skills: [] }),
    ).toEqual([])
  })

  test('两个分组都由内容决定显隐', () => {
    const toolkit = mergeToolkits([{ skills: [skill('翻译')], mcpServers: [server('github')] }])
    const groups = composerPaletteGroups({
      controls: [],
      mcpServers: toolkit.mcpServers,
      onSelectControl: () => undefined,
      skills: toolkit.skills,
    })

    expect(groups.map((group) => group.heading)).toEqual(['技能', 'MCP'])
    expect(groups[0]?.rows[0]?.label).toBe('翻译')
    expect(groups[1]?.rows[0]?.label).toBe('github')
  })

  test('技能那一行插进正文的是一枚技能记号（提交时按 name 交给 agent）', () => {
    const groups = composerPaletteGroups({
      controls: [],
      mcpServers: [],
      onSelectControl: () => undefined,
      skills: mergeToolkits([{ skills: [skill('翻译')], mcpServers: [] }]).skills,
    })

    expect(groups[0]?.rows[0]?.action).toEqual({ kind: 'insert', chip: { kind: 'skill', name: '翻译' } })
  })

  test('技能按名字去重，排在前面的来源优先', () => {
    const merged = mergeToolkits([
      { skills: [skill('翻译', '第一个来源')], mcpServers: [] },
      { skills: [skill('翻译', '第二个来源'), skill('总结')], mcpServers: [] },
    ])

    expect(merged.skills.map((row) => row.name)).toEqual(['翻译', '总结'])
    expect(merged.skills[0]?.description).toBe('第一个来源')
  })

  test('MCP 的四态换算成面板的四态：disconnected 原样、failed → error', () => {
    const merged = mergeToolkits([
      {
        skills: [],
        mcpServers: [
          server('a', 'connected'),
          server('b', 'connecting'),
          server('c', 'failed'),
          server('d', 'disconnected'),
        ],
      },
    ])

    expect(merged.mcpServers.map((row) => row.status)).toEqual(['connected', 'connecting', 'error', 'disconnected'])
    /* id 与 name 同值：行身份与正文里那枚记号读的是同一格。 */
    expect(merged.mcpServers[0]?.id).toBe('a')
  })

  test('MCP 的错误原文有话说才带上', () => {
    const merged = mergeToolkits([
      { skills: [], mcpServers: [{ name: 'x', state: 'failed', toolCount: 0, error: '端口被占' }] },
    ])

    expect(merged.mcpServers[0]?.lastError).toBe('端口被占')
  })
})

describe('read 的引用稳定性', () => {
  /* 一个按脚本回话的假来源：read 交回它此刻握着的那一份。 */
  function sourceOf(initial: ComposerToolkit): ComposerToolkitSource & { put(next: ComposerToolkit): void } {
    let held = initial

    return {
      id: 'test',
      ensure: () => undefined,
      read: () => held,
      subscribe: () => () => undefined,
      put: (next) => {
        held = next
      },
    }
  }

  test('来源对象没换就交回同一个合并结果', () => {
    const source = sourceOf({ skills: [skill('翻译')], mcpServers: [server('github')] })
    const read = toolkitReaderOf([source], null)

    const first = read()

    expect(read()).toBe(first)
  })

  test('来源换了一份数据才生成新对象', () => {
    const source = sourceOf({ skills: [skill('翻译')], mcpServers: [] })
    const read = toolkitReaderOf([source], null)
    const first = read()

    source.put({ skills: [skill('翻译'), skill('总结')], mcpServers: [] })

    const second = read()

    expect(second).not.toBe(first)
    expect(second.skills.map((row) => row.name)).toEqual(['翻译', '总结'])
    expect(read()).toBe(second)
  })

  test('没有来源时交回空名册，也是同一个引用', () => {
    const read = toolkitReaderOf([], null)

    const first = read()

    expect(first.skills).toHaveLength(0)
    expect(read()).toBe(first)
  })
})
