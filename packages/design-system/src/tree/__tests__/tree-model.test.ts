import { describe, expect, test } from 'bun:test'
import { pathTreeRows } from '../path-tree'
import { type TreeKeyRow, treeKeyEffect } from '../tree-keys'

describe('pathTreeRows：路径集画成树', () => {
  test('目录在前，只有一个子目录且没有直属文件的段并成一行', () => {
    const rows = pathTreeRows(['src/review/ui/a.tsx', 'src/review/ui/b.tsx', 'README.md'], new Set())
    expect(rows.map((row) => [row.kind, row.key, row.label, row.depth])).toEqual([
      ['folder', 'src/review/ui', 'src/review/ui', 0],
      ['file', 'src/review/ui/a.tsx', 'a.tsx', 1],
      ['file', 'src/review/ui/b.tsx', 'b.tsx', 1],
      ['file', 'README.md', 'README.md', 0],
    ])
  })

  test('收起的目录不列孩子', () => {
    const rows = pathTreeRows(['a/x.ts', 'a/y/z.ts', 'b.ts'], new Set(['a']))
    expect(rows.map((row) => row.key)).toEqual(['a', 'b.ts'])
  })
})

describe('treeKeyEffect：WAI-ARIA 树的键盘语义', () => {
  const rows: readonly TreeKeyRow[] = [
    { kind: 'folder', key: 'src', depth: 0, expanded: true },
    { kind: 'file', key: 'src/a.ts', depth: 1 },
    { kind: 'folder', key: 'src/lib', depth: 1, expanded: false },
    { kind: 'file', key: 'README.md', depth: 0 },
  ]

  test('上下 / Home / End 移焦点，到头不动', () => {
    expect(treeKeyEffect(rows, 'src', 'ArrowDown')).toEqual({ kind: 'focus', key: 'src/a.ts' })
    expect(treeKeyEffect(rows, 'src', 'ArrowUp')).toEqual({ kind: 'none' })
    expect(treeKeyEffect(rows, 'src/a.ts', 'End')).toEqual({ kind: 'focus', key: 'README.md' })
    expect(treeKeyEffect(rows, 'README.md', 'Home')).toEqual({ kind: 'focus', key: 'src' })
  })

  test('向右：收着的目录展开，展开着的进第一个孩子，文件不动', () => {
    expect(treeKeyEffect(rows, 'src/lib', 'ArrowRight')).toEqual({ kind: 'toggle', key: 'src/lib' })
    expect(treeKeyEffect(rows, 'src', 'ArrowRight')).toEqual({ kind: 'focus', key: 'src/a.ts' })
    expect(treeKeyEffect(rows, 'src/a.ts', 'ArrowRight')).toEqual({ kind: 'none' })
  })

  test('向左：展开着的目录收起，否则回父目录', () => {
    expect(treeKeyEffect(rows, 'src', 'ArrowLeft')).toEqual({ kind: 'toggle', key: 'src' })
    expect(treeKeyEffect(rows, 'src/a.ts', 'ArrowLeft')).toEqual({ kind: 'focus', key: 'src' })
    expect(treeKeyEffect(rows, 'README.md', 'ArrowLeft')).toEqual({ kind: 'none' })
  })

  test('Enter / 空格：目录开合，文件打开；认不得的键与行不做事', () => {
    expect(treeKeyEffect(rows, 'src/lib', 'Enter')).toEqual({ kind: 'toggle', key: 'src/lib' })
    expect(treeKeyEffect(rows, 'README.md', ' ')).toEqual({ kind: 'activate', key: 'README.md' })
    expect(treeKeyEffect(rows, 'README.md', 'a')).toEqual({ kind: 'none' })
    expect(treeKeyEffect(rows, 'missing', 'ArrowDown')).toEqual({ kind: 'none' })
  })
})
