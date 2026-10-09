import { describe, expect, test } from 'bun:test'
import { camel, renderFeature, renderPackage } from '../templates'

describe('scaffold templates', () => {
  test('renderPackage 生成 4 个文件，bun 运行时带 @types/bun', () => {
    const files = renderPackage('fs-kit', 'bun')
    expect(Object.keys(files).sort()).toEqual([
      'packages/fs-kit/README.md',
      'packages/fs-kit/package.json',
      'packages/fs-kit/src/index.ts',
      'packages/fs-kit/tsconfig.json',
    ])
    const pkg = JSON.parse(files['packages/fs-kit/package.json']!)
    expect(pkg.name).toBe('@poietica/fs-kit')
    expect(pkg.devDependencies).toEqual({ '@types/bun': 'catalog:' })
    expect(JSON.parse(files['packages/fs-kit/tsconfig.json']!).extends).toBe('../../tooling/tsconfig/bun.json')
  })

  test('renderFeature：只生成请求的子入口，预设正确', () => {
    const files = renderFeature('agent-settings', ['core', 'ui'])
    const pkg = JSON.parse(files['features/agent-settings/package.json']!)
    expect(Object.keys(pkg.exports)).toEqual(['./contract', './core', './ui'])
    expect(files['features/agent-settings/src/host/index.ts']).toBeUndefined()
    expect(JSON.parse(files['features/agent-settings/src/core/tsconfig.json']!).extends).toBe(
      '../../../../tooling/tsconfig/bun.json',
    )
    expect(JSON.parse(files['features/agent-settings/src/ui/tsconfig.json']!).extends).toBe(
      '../../../../tooling/tsconfig/dom.json',
    )
    expect(files['features/agent-settings/src/contract/index.ts']).toContain("namespaces: ['agentSettings']")
    expect(pkg.dependencies['@poietica/core-kernel']).toBe('workspace:*')
  })

  test('camel', () => {
    expect(camel('agent-settings')).toBe('agentSettings')
  })
})
