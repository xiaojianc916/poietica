import { describe, expect, test } from 'bun:test'
import type { DirectoryListing, FileEntry } from '../../contract'
import { FileTreeModel } from '../tree-model'

const file = (path: string, ignored = false): FileEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  kind: 'file',
  ignored,
})
const folder = (path: string): FileEntry => ({ ...file(path), kind: 'directory' })

function fakeApi(tree: Record<string, readonly FileEntry[]>) {
  const listed: string[] = []
  const searched: string[] = []
  return {
    listed,
    searched,
    api: {
      list: async (_workspaceId: string, path: string): Promise<DirectoryListing> => {
        listed.push(path)
        const entries = tree[path]
        if (entries === undefined) throw new Error(`no ${path}`)
        return { path, entries: [...entries], truncated: false }
      },
      search: async (_workspaceId: string, query: string) => {
        searched.push(query)
        return { hits: ['src/deep/a.ts', 'src/b.ts'], truncated: false }
      },
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const TREE = {
  '': [folder('src'), file('README.md'), file('dist.js', true)],
  src: [folder('src/deep'), file('src/b.ts')],
  'src/deep': [file('src/deep/a.ts')],
}

describe('FileTreeModel：懒加载的工作区树', () => {
  test('start 只读根；展开才读子目录；行带深度、展开态与忽略标记', async () => {
    const { api, listed } = fakeApi(TREE)
    const model = new FileTreeModel('w1', api, () => undefined)
    model.start()
    model.start()
    await settle()
    expect(listed).toEqual([''])
    expect(model.rows().map((row) => [row.key, row.depth, row.expanded, row.dimmed])).toEqual([
      ['src', 0, false, undefined],
      ['README.md', 0, undefined, undefined],
      ['dist.js', 0, undefined, true],
    ])
    const src = model.rows()[0]
    if (src === undefined) throw new Error('no src row')
    model.toggle(src)
    await settle()
    expect(listed).toEqual(['', 'src'])
    expect(model.rows().map((row) => row.key)).toEqual(['src', 'src/deep', 'src/b.ts', 'README.md', 'dist.js'])
  })

  test('rows 按版本记忆：没变化时交回同一个数组', async () => {
    const { api } = fakeApi(TREE)
    const model = new FileTreeModel('w1', api, () => undefined)
    model.start()
    await settle()
    expect(model.rows()).toBe(model.rows())
  })

  test('reveal 展开每一层祖先（缺的读进来）；open 时连目录自己也展开', async () => {
    const { api, listed } = fakeApi(TREE)
    const model = new FileTreeModel('w1', api, () => undefined)
    model.start()
    model.reveal('src/deep/a.ts')
    await settle()
    expect(listed.sort()).toEqual(['', 'src', 'src/deep'])
    expect(model.rows().map((row) => row.key)).toContain('src/deep/a.ts')
    model.collapseAll()
    model.reveal('src', true)
    await settle()
    expect(model.rows().map((row) => row.key)).toEqual(['src', 'src/deep', 'src/b.ts', 'README.md', 'dist.js'])
  })

  test('changed 只重读读过的、受影响的目录；null 全部重读', async () => {
    const { api, listed } = fakeApi(TREE)
    const model = new FileTreeModel('w1', api, () => undefined)
    model.start()
    await settle()
    listed.length = 0
    model.changed(['src/deep/a.ts', 'README.md'])
    await settle()
    expect(listed).toEqual([''])
    listed.length = 0
    model.changed(null)
    await settle()
    expect(listed).toEqual([''])
  })

  test('子目录读不到（刚被删）：从账上拿掉、收起，并上报；根读不到才画失败', async () => {
    const reports: string[] = []
    const { api } = fakeApi({ '': [folder('gone')] })
    const model = new FileTreeModel('w1', api, (what) => {
      reports.push(what)
    })
    model.start()
    await settle()
    const gone = model.rows()[0]
    if (gone === undefined) throw new Error('no row')
    model.toggle(gone)
    await settle()
    expect(model.rows()[0]?.expanded).toBe(false)
    expect(reports).toEqual(['list'])
    const broken = new FileTreeModel('w1', fakeApi({}).api, () => undefined)
    broken.start()
    await settle()
    expect(broken.rootState()).toBe('failed')
  })

  test('筛选：去抖后问 Core，结果画成稀疏树（默认全展开，可收起）；清空回到原树', async () => {
    const { api, searched } = fakeApi(TREE)
    const model = new FileTreeModel('w1', api, () => undefined)
    model.start()
    await settle()
    model.setQuery('a')
    model.setQuery('a.ts')
    expect(model.searchState().phase).toBe('searching')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(searched).toEqual(['a.ts'])
    const keys = model.rows().map((row) => row.key)
    expect(keys).toContain('src/deep/a.ts')
    expect(keys).toContain('src/b.ts')
    const top = model.rows()[0]
    if (top === undefined) throw new Error('no row')
    model.toggle(top)
    expect(model.rows()).toHaveLength(1)
    model.setQuery('')
    expect(model.rows().map((row) => row.key)).toEqual(['src', 'README.md', 'dist.js'])
  })
})
