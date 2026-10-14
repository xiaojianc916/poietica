import { describe, expect, test } from 'bun:test'
import type { McpCatalogEntry } from '../../contract'
import {
  availableServerName,
  builtinServerRows,
  groupRows,
  isRegistryRow,
  missingRegistryInputs,
  registryServerBody,
  registryServerRows,
} from '../catalog'

/*
 * 在线目录（Smithery）那一层的数据逻辑。**不发网络**：只喂契约形状的条目，钉映射与合并规则。
 * 这三件事都不需要渲染，所以不进 happy-dom。
 */

function entry(over: Partial<McpCatalogEntry> = {}): McpCatalogEntry {
  return {
    id: 'x/one',
    name: 'x-one',
    title: 'One',
    description: '说明',
    homepage: null,
    sourceType: 'remote',
    useCount: 1,
    verified: false,
    inputs: [],
    warnings: [],
    config: { type: 'http', url: 'https://one.test/mcp' },
    ...over,
  }
}

describe('目录条目的正文', () => {
  test('没有补输入时原样交回目录给的正文', () => {
    const body = { type: 'http', url: 'https://one.test/mcp' }
    expect(registryServerBody(entry({ config: body }), {})).toEqual(body)
  })

  /* 照抄 omp 的 #applyRegistryInputOverrides：值串成 JSON 填在 --config 上。 */
  test('stdio + 有输入：值填进 --config 那一格', () => {
    const config = { type: 'stdio', command: 'bunx', args: ['-y', '@smithery/cli', 'run', '@a/b', '--config', '{}'] }
    const body = registryServerBody(entry({ config }), { KEY: 'secret' })

    expect(body.args).toEqual(['-y', '@smithery/cli', 'run', '@a/b', '--config', JSON.stringify({ KEY: 'secret' })])
  })

  test('没有 --config 的位置就追加一对', () => {
    const config = { type: 'stdio', command: 'npx', args: ['server'] }
    const body = registryServerBody(entry({ config }), { KEY: 'v' })

    expect(body.args).toEqual(['server', '--config', JSON.stringify({ KEY: 'v' })])
  })

  test('空白值不算填了', () => {
    const config = { type: 'stdio', command: 'npx', args: ['--config', '{}'] }
    expect(registryServerBody(entry({ config }), { KEY: '   ' })).toEqual(config)
  })

  /* 远程条目的凭据走 OAuth / 请求头，目录也没给 --config 的位置：不假装填进去了。 */
  test('远程条目即使给了值也不改正文', () => {
    const config = { type: 'http', url: 'https://one.test/mcp' }
    expect(registryServerBody(entry({ config }), { KEY: 'v' })).toEqual(config)
  })

  test('必填项没填时列出来；defaultValue 视为已填', () => {
    const withInput = entry({
      inputs: [
        { key: 'A', label: 'A', required: true, sensitive: false, defaultValue: null, description: null },
        { key: 'B', label: 'B', required: true, sensitive: false, defaultValue: '预设', description: null },
        { key: 'C', label: 'C', required: false, sensitive: false, defaultValue: null, description: null },
      ],
    })

    expect(missingRegistryInputs(withInput, {})).toEqual(['A'])
    expect(missingRegistryInputs(withInput, { A: 'v' })).toEqual([])
  })
})

describe('配置名去重', () => {
  test('没占用就用原名；占了按 omp 的规矩加 -2、-3', () => {
    expect(availableServerName('alpha', new Set())).toBe('alpha')
    expect(availableServerName('alpha', new Set(['alpha']))).toBe('alpha-2')
    expect(availableServerName('alpha', new Set(['alpha', 'alpha-2']))).toBe('alpha-3')
  })
})

describe('目录行与精选行合并', () => {
  test('目录行带 kind 与 entry，精选行没有', () => {
    const registry = registryServerRows([entry()], [])
    expect(registry).toHaveLength(1)
    expect(isRegistryRow(registry[0]!)).toBe(true)

    const builtin = builtinServerRows([], '')
    expect(builtin.length).toBeGreaterThan(0)
    expect(builtin.every((row) => !isRegistryRow(row))).toBe(true)
  })

  test('已装判据用**归一后**的名字（目录名带斜杠，写盘前已归一）', () => {
    const rows = registryServerRows([entry({ name: 'x-one' })], [{ name: 'x-one' }])
    expect(rows[0]?.status.kind).toBe('installed')
    /* 原名不算已装 —— 写盘的是归一后的那个。 */
    const other = registryServerRows([entry({ id: 'y', name: 'y-two' })], [{ name: 'y/two' }])
    expect(other[0]?.status.kind).toBe('installable')
  })

  test('分组把精选与在线目录都排到别的前面，精选在前', () => {
    const groups = groupRows([...builtinServerRows([], ''), ...registryServerRows([entry()], [])])

    expect(groups.map((group) => group.title).slice(0, 2)).toEqual(['精选', '在线目录'])
  })

  test('行类型穿过分组不丢（卡片据此选动作区）', () => {
    const groups = groupRows(registryServerRows([entry()], []))
    expect(isRegistryRow(groups[0]!.rows[0]!)).toBe(true)
  })
})
