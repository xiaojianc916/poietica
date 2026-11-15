import { describe, expect, test } from 'bun:test'
import { openDatabase } from '@poietica/storage-sqlite'
import { fakeClock } from '@poietica/test-kit'
import { migrations } from '../migrations'
import { createSettingsService } from '../service'

function service() {
  const root = openDatabase(':memory:')
  const db = root.forModule('settings')
  db.exec(migrations[0]!.sql)
  return {
    db,
    root,
    settings: createSettingsService({ db, clock: fakeClock() }),
  }
}

describe('settings registry', () => {
  test('优先级 thread > project > global > default', () => {
    const { root, settings } = service()
    settings.register({
      key: 'policy.preset',
      label: '策略预设',
      type: 'select',
      scopes: ['global', 'project', 'thread'],
      defaultValue: 'auto-edit',
      options: [
        { value: 'read-only', label: '只读' },
        { value: 'auto-edit', label: '工作区自动' },
      ],
    })
    expect(settings.get('policy.preset').source).toBe('default')
    settings.set({ key: 'policy.preset', scope: 'global', scopeId: 'global', value: 'read-only' })
    expect(settings.get('policy.preset', { workspaceId: 'w1' }).value).toBe('read-only')
    root.close()
  })

  test('敏感项不回明文，类型与作用域校验', () => {
    const { root, settings } = service()
    settings.register({
      key: 'secret.token',
      label: '令牌',
      type: 'string',
      scopes: ['global'],
      defaultValue: '',
      sensitive: true,
    })
    settings.set({ key: 'secret.token', scope: 'global', scopeId: 'global', value: 'abc' })
    expect(settings.get('secret.token')).toMatchObject({ value: null, configured: true })
    expect(() => settings.set({ key: 'secret.token', scope: 'thread', scopeId: 't', value: 'x' })).toThrow(
      '不支持 thread',
    )
    root.close()
  })
})

describe('settings providers', () => {
  test('外部 provider 参与 describeAll，写入路由给它而不是本地表', async () => {
    const { root, settings } = service()
    const writes: unknown[] = []
    settings.registerProvider({
      id: 'external',
      owns: (key) => key.startsWith('ext.'),
      describe: async () => [
        {
          definition: {
            key: 'ext.value',
            label: '外部值',
            type: 'string',
            scopes: ['global'],
            defaultValue: 'd',
          },
          value: 'v',
          source: 'global',
          configured: true,
        },
      ],
      set: async (input) => {
        writes.push(input.value)
      },
    })
    expect((await settings.describeAll()).map((view) => view.definition.key)).toEqual(['ext.value'])
    await settings.write({ key: 'ext.value', scope: 'global', scopeId: 'global', value: 'next' })
    expect(writes).toEqual(['next'])
    expect(() => settings.get('ext.value')).toThrow()
    root.close()
  })
})
