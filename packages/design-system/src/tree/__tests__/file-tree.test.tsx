import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { FileTree, type FileTreeRow } from '../file-tree'

/* happy-dom 没有布局：树的滚动口高度由 clientHeight 桩给出（十行高），虚拟器按它算出该挂哪些行。 */
const VIEWPORT_PX = 280
const realClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('file-tree') ? VIEWPORT_PX : 0
    },
  })
})

afterEach(() => {
  cleanup()
  if (realClientHeight !== undefined) Object.defineProperty(HTMLElement.prototype, 'clientHeight', realClientHeight)
})

const rows: readonly FileTreeRow[] = [
  { kind: 'folder', key: 'src', label: 'src', depth: 0, expanded: true },
  { kind: 'file', key: 'src/a.ts', label: 'a.ts', depth: 1 },
  { kind: 'file', key: 'dist.js', label: 'dist.js', depth: 0, dimmed: true },
]

describe('FileTree', () => {
  test('role=tree / treeitem，层级、展开、选中态都在无障碍树上；一行一个 tab 停靠点', () => {
    const view = render(
      <FileTree
        label="工作区文件"
        onOpen={() => undefined}
        onToggle={() => undefined}
        rows={rows}
        selectedKey="src/a.ts"
      />,
    )
    const tree = view.getByRole('tree', { name: '工作区文件' })
    const items = view.getAllByRole('treeitem')
    expect(tree).toBeDefined()
    expect(items.map((item) => item.getAttribute('aria-level'))).toEqual(['1', '2', '1'])
    expect(items[0]?.getAttribute('aria-expanded')).toBe('true')
    expect(items[1]?.getAttribute('aria-expanded')).toBeNull()
    expect(items[1]?.getAttribute('aria-selected')).toBe('true')
    expect(items.map((item) => item.tabIndex)).toEqual([-1, 0, -1])
    expect(items[2]?.hasAttribute('data-dimmed')).toBe(true)
  })

  test('文件行画的是它自己的文件类型图标，不是通用文档', () => {
    const view = render(<FileTree label="t" onOpen={() => undefined} onToggle={() => undefined} rows={rows} />)
    const marks = [...view.getAllByRole('treeitem')[1]!.querySelectorAll('img[data-file-mark]')]

    expect(marks).toHaveLength(1)
    expect(marks[0]?.getAttribute('alt')).toBe('')
  })

  test('点目录开合、点文件打开；键盘 Enter 同理，方向键移焦点', () => {
    const toggled: string[] = []
    const opened: string[] = []
    const view = render(
      <FileTree
        label="t"
        onOpen={(row) => opened.push(row.key)}
        onToggle={(row) => toggled.push(row.key)}
        rows={rows}
      />,
    )
    const [folder, file] = view.getAllByRole('treeitem')
    if (folder === undefined || file === undefined) throw new Error('rows missing')
    fireEvent.click(folder)
    fireEvent.click(file)
    fireEvent.keyDown(file, { key: 'Enter' })
    expect(toggled).toEqual(['src'])
    expect(opened).toEqual(['src/a.ts', 'src/a.ts'])
    fireEvent.keyDown(file, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toContain('dist.js')
  })

  test('兄弟位置自报：aria-setsize / aria-posinset 按同一父亲下的兄弟数（行不全在 DOM 里，读屏靠它）', () => {
    const nested: readonly FileTreeRow[] = [
      { kind: 'folder', key: 'src', label: 'src', depth: 0, expanded: true },
      { kind: 'file', key: 'src/a.ts', label: 'a.ts', depth: 1 },
      { kind: 'file', key: 'src/b.ts', label: 'b.ts', depth: 1 },
      { kind: 'file', key: 'README.md', label: 'README.md', depth: 0 },
    ]
    const view = render(<FileTree label="t" onOpen={() => undefined} onToggle={() => undefined} rows={nested} />)
    const items = view.getAllByRole('treeitem')
    expect(items.map((item) => item.getAttribute('aria-setsize'))).toEqual(['2', '2', '2', '2'])
    expect(items.map((item) => item.getAttribute('aria-posinset'))).toEqual(['1', '1', '2', '2'])
  })
})

describe('FileTree 虚拟化', () => {
  const many: readonly FileTreeRow[] = Array.from({ length: 5000 }, (_, index) => ({
    kind: 'file',
    key: `f${String(index)}.ts`,
    label: `f${String(index)}.ts`,
    depth: 0,
  }))

  test('五千行只挂视口附近的一小段，滚动高度按全部行撑起', () => {
    const view = render(<FileTree label="t" onOpen={() => undefined} onToggle={() => undefined} rows={many} />)
    const items = view.getAllByRole('treeitem')
    expect(items.length).toBeLessThan(50)
    expect(items[0]?.getAttribute('aria-setsize')).toBe('5000')
    const sizer = view.getByRole('tree').firstElementChild as HTMLElement
    /* 滚动高度按全部行撑起：整份列表的高度必须远大于视口，而不是只按挂出来的那几行算。 */
    expect(Number.parseFloat(sizer.style.height)).toBeGreaterThan(VIEWPORT_PX)
  })

  test('漫游焦点那一行不在视口里也挂着：Tab 进树仍有落点', () => {
    const view = render(
      <FileTree label="t" onOpen={() => undefined} onToggle={() => undefined} rows={many} selectedKey="f4321.ts" />,
    )
    const stop = view.getAllByRole('treeitem').find((item) => item.tabIndex === 0)
    expect(stop?.textContent).toContain('f4321.ts')
    expect(stop?.getAttribute('aria-posinset')).toBe('4322')
  })

  test('End 跳到还没渲染的最后一行：先挂上再给焦点', () => {
    const view = render(<FileTree label="t" onOpen={() => undefined} onToggle={() => undefined} rows={many} />)
    const first = view.getAllByRole('treeitem')[0]
    if (first === undefined) throw new Error('rows missing')
    fireEvent.keyDown(first, { key: 'End' })
    expect(document.activeElement?.getAttribute('role')).toBe('treeitem')
    expect(document.activeElement?.textContent).toContain('f4999.ts')
    expect((document.activeElement as HTMLElement).tabIndex).toBe(0)
  })

  test('revealKey：那一行出现了就滚过去并回报一次；还没出现（祖先在读）就等着', () => {
    const revealed: string[] = []
    const view = render(
      <FileTree
        label="t"
        onOpen={() => undefined}
        onRevealed={(key) => revealed.push(key)}
        onToggle={() => undefined}
        revealKey="f4000.ts"
        rows={many.slice(0, 10)}
      />,
    )
    expect(revealed).toEqual([])
    view.rerender(
      <FileTree
        label="t"
        onOpen={() => undefined}
        onRevealed={(key) => revealed.push(key)}
        onToggle={() => undefined}
        revealKey="f4000.ts"
        rows={many}
      />,
    )
    expect(revealed).toEqual(['f4000.ts'])
    const stop = view.getAllByRole('treeitem').find((item) => item.tabIndex === 0)
    expect(stop?.textContent).toContain('f4000.ts')
  })
})
