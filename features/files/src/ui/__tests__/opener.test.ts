import { describe, expect, test } from 'bun:test'
import type { LocatedFile } from '../../contract'
import { createFileOpener, TREE_PANEL_ID, VIEWER_PANEL_ID } from '../opener'
import { FileTabsStore } from '../tabs'

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function make(o: {
  activeOwner?: string | null
  activeWorkspace?: string | null
  locate?: () => Promise<LocatedFile>
}) {
  const calls: string[] = []
  const tabs = new FileTabsStore()
  const opener = createFileOpener({
    api: {
      locate:
        o.locate ??
        (async (_workspaceId, path) => ({ path: path.replace(/^C:\\repo\\/u, ''), absolutePath: path, kind: 'file' })),
    },
    tabs,
    layout: {
      current: () => ({ auxiliary: { activeOwner: o.activeOwner ?? null } }),
      focusPane: (owner: string, paneId: string) => {
        calls.push(`focus ${owner} ${paneId}`)
      },
      setDockOpen: (owner: string, open: boolean) => {
        calls.push(`dock ${owner} ${String(open)}`)
      },
    } as never,
    workspaces: { store: { getState: () => ({ items: [], activeId: o.activeWorkspace ?? null }) } as never },
    banners: {
      show: (banner: { title: string }) => {
        calls.push(`banner ${banner.title}`)
      },
      error: (_cause: unknown, title?: string) => {
        calls.push(`error ${String(title)}`)
      },
    } as never,
    revealInTree: (owner, workspaceId, path) => {
      calls.push(`reveal ${owner} ${workspaceId} ${path}`)
    },
  })
  return { opener, tabs, calls }
}

describe('createFileOpener', () => {
  test('树里点的：直接开标签、选中查看器那一组、打开坞', () => {
    const { opener, tabs, calls } = make({})
    opener.openListed('t1', 'w1', 'src/a.ts')
    expect(tabs.of('t1')?.ids).toHaveLength(1)
    expect(calls).toEqual([`focus t1 ${VIEWER_PANEL_ID}`, 'dock t1 true'])
  })

  test('正文里写的：先经 Core 解析成工作区内的相对路径，再带行号开', async () => {
    const { opener, tabs, calls } = make({})
    opener.openReference({ path: 'C:\\repo\\src\\a.ts', line: 12, column: null, owner: 't1', workspaceId: 'w1' })
    await settle()
    const id = tabs.of('t1')?.activeId ?? ''
    expect(tabs.tab(id)?.path).toBe('src\\a.ts')
    expect(tabs.revealOf('t1', id)?.line).toBe(12)
    expect(calls).toEqual([`focus t1 ${VIEWER_PANEL_ID}`, 'dock t1 true'])
  })

  test('是目录：在树里定位，不开标签', async () => {
    const { opener, tabs, calls } = make({
      locate: async () => ({ path: 'src', absolutePath: '/repo/src', kind: 'directory' }),
    })
    opener.openReference({ path: 'src/', owner: 't1', workspaceId: 'w1' })
    await settle()
    expect(tabs.of('t1')).toBeNull()
    expect(calls).toEqual(['reveal t1 w1 src'])
    expect(TREE_PANEL_ID).toBe('files.tree')
  })

  test('没给归属 / 工作区就用当前前台与当前工作区；都没有时说一句，不发请求', async () => {
    const fallback = make({ activeOwner: 't9', activeWorkspace: 'w9' })
    fallback.opener.openReference({ path: 'a.ts' })
    await settle()
    expect(fallback.tabs.of('t9')?.ids).toHaveLength(1)

    let asked = false
    const none = make({
      locate: async () => {
        asked = true
        return { path: 'a.ts', absolutePath: '/a.ts', kind: 'file' }
      },
    })
    none.opener.openReference({ path: 'a.ts' })
    await settle()
    expect(asked).toBe(false)
    expect(none.calls).toEqual(['banner 这里打不开文件'])
  })

  test('Core 拒绝（越界、不存在）：横幅报错，不开标签', async () => {
    const { opener, tabs, calls } = make({ locate: () => Promise.reject(new Error('outside')) })
    opener.openReference({ path: '/etc/passwd', owner: 't1', workspaceId: 'w1' })
    await settle()
    expect(tabs.of('t1')).toBeNull()
    expect(calls).toEqual(['error 打不开这个文件'])
  })
})
