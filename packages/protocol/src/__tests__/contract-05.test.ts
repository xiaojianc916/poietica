import { describe, expect, test } from 'bun:test'
import { appContract } from '../index'

/*
 * 05 页（通信）的可机检清单：§10 的超时默认值，以及 §11 里逐个点名的字段形状。
 * 这些点由 2026-10-07 的符合性整改钉住；改动契约时要一起改这里，并按 §8 提升 PROTOCOL_VERSION。
 */
const method = (name: string) => {
  const def = appContract.methods.get(name)
  if (def === undefined) throw new Error(`契约里没有方法 ${name}`)
  return def
}
const notification = (name: string) => {
  const def = appContract.notifications.get(name)
  if (def === undefined) throw new Error(`契约里没有通知 ${name}`)
  return def
}

describe('T-05-TIMEOUT 超时默认值（05 §10）', () => {
  const rows: [string, number][] = [
    ['turns.submit', 60_000],
    ['git.review', 60_000],
    ['git.commit', 60_000],
    ['plugins.install', 300_000],
    ['skills.install', 300_000],
    ['python.install', 300_000],
    ['threads.export', 120_000],
    ['dialog.pickFolder', 0],
    ['dialog.pickFiles', 0],
    ['dialog.pickSavePath', 0],
    ['core.shutdown', 15_000],
    ['core.restart', 60_000],
    ['core.getStatus', 30_000],
  ]
  for (const [name, ms] of rows) {
    test(`${name} = ${ms}`, () => {
      expect(method(name).timeoutMs).toBe(ms)
    })
  }
})

describe('T-05-FIELDS §11 点名的字段形状', () => {
  const skill = { id: '/s', name: 's', description: '', source: 'user', enabled: true, path: 'D:/s' }
  const plugin = { id: 'p', name: 'p', version: '1.0.0', description: '', enabled: true, source: 'market' }
  const status = { name: 'm', state: 'connected', toolCount: 1, error: null }

  test('extensions：skillId / pluginId / 实体直返 / servers', () => {
    expect(method('skills.setEnabled').params.safeParse({ skillId: 's', enabled: true }).success).toBe(true)
    expect(method('skills.setEnabled').params.safeParse({ id: 's', enabled: true }).success).toBe(false)
    expect(method('skills.remove').params.safeParse({ skillId: 's' }).success).toBe(true)
    expect(method('skills.read').params.safeParse({ skillId: 's' }).success).toBe(true)
    expect(method('skills.install').result.safeParse(skill).success).toBe(true)
    expect(method('skills.install').result.safeParse({ skill }).success).toBe(false)
    expect(method('plugins.install').params.safeParse({ pluginId: 'p' }).success).toBe(true)
    expect(method('plugins.install').params.safeParse({ id: 'p' }).success).toBe(false)
    expect(method('plugins.uninstall').params.safeParse({ pluginId: 'p' }).success).toBe(true)
    expect(method('plugins.setEnabled').params.safeParse({ pluginId: 'p', enabled: false }).success).toBe(true)
    expect(method('plugins.install').result.safeParse(plugin).success).toBe(true)
    expect(method('plugins.install').result.safeParse({ plugin }).success).toBe(false)
    expect(method('mcp.status').result.safeParse({ servers: [status] }).success).toBe(true)
    expect(method('mcp.status').result.safeParse({ statuses: [status] }).success).toBe(false)
    expect(notification('mcp.statusChanged').params.safeParse({ servers: [status] }).success).toBe(true)
    expect(notification('mcp.statusChanged').params.safeParse({ statuses: [status] }).success).toBe(false)
  })

  test('skills.list 的 workspaceId 是可选的；缺省与给值都合法', () => {
    expect(method('skills.list').params.safeParse({}).success).toBe(true)
    expect(method('skills.list').params.safeParse({ workspaceId: 'w' }).success).toBe(true)
    expect(method('skills.list').params.safeParse({ workspaceId: null }).success).toBe(false)
  })

  test('controls.draft 三格是必填可空（null = 用默认值）', () => {
    expect(method('controls.draft').params.safeParse({ model: null, thinking: null, posture: null }).success).toBe(true)
    expect(method('controls.draft').params.safeParse({}).success).toBe(false)
  })

  test('git.filePatch 没有 untracked 参数；git.createBranch 的 from 可省', () => {
    const parsed = method('git.filePatch').params.safeParse({
      workspaceId: 'w',
      path: 'a.txt',
      base: 'HEAD',
      untracked: true,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect('untracked' in (parsed.data as Record<string, unknown>)).toBe(false)
    expect(method('git.createBranch').params.safeParse({ workspaceId: 'w', branch: 'b' }).success).toBe(true)
  })

  test('threads.list：workspaceId 可选、includeArchived 必填', () => {
    expect(method('threads.list').params.safeParse({ includeArchived: false }).success).toBe(true)
    expect(method('threads.list').params.safeParse({}).success).toBe(false)
  })
})
