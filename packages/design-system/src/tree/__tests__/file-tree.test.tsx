import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { FileTree, type FileTreeRow } from '../file-tree'

afterEach(cleanup)

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

  test('文件行用 Material 文件图标（不是 lucide 的图）', () => {
    const view = render(<FileTree label="t" onOpen={() => undefined} onToggle={() => undefined} rows={rows} />)
    const file = view.getAllByRole('treeitem')[1]
    expect(file?.querySelector('img')).not.toBeNull()
    expect(file?.querySelector('svg')).toBeNull()
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
})
