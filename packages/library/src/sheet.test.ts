import { describe, expect, test } from 'bun:test'
import type { TableSheet } from '@poietica/contract/library'
import { EMPTY_VIEW, fields, project, removeField, retarget, tintOf } from './sheet'

const SHEET: TableSheet = {
  header: ['标题', '数字', '单选', '日期'],
  rows: [
    ['乙', '10', '甲类', '2026-01-02'],
    ['甲', '9', '乙类', '2026-01-01'],
    ['丙', '', '甲类', ''],
  ],
}

describe('sheet', () => {
  test('字段类型由列里的值推断', () => {
    expect(fields(SHEET).map((field) => field.kind)).toEqual(['text', 'number', 'select', 'date'])
  })

  test('数字列按数值排序而不是按字典序', () => {
    const view = { ...EMPTY_VIEW, sorts: [{ id: 'a', field: 1, descending: false }] }
    const [group] = project(SHEET, view)

    expect(group?.rows.map((row) => row.cells[1])).toEqual(['9', '10', ''])
  })

  test('筛选不改底层行号，写回不会错行', () => {
    const view = {
      ...EMPTY_VIEW,
      filters: [{ id: 'a', field: 1, test: 'greater' as const, operand: '9' }],
    }
    const [group] = project(SHEET, view)

    expect(group?.rows.map((row) => row.index)).toEqual([0])
  })

  test('分组把同一取值收到一处', () => {
    const view = { ...EMPTY_VIEW, groups: [{ id: 'a', field: 2 }] }

    expect(project(SHEET, view).map((group) => [group.label, group.rows.length])).toEqual([
      ['甲类', 2],
      ['乙类', 1],
    ])
  })

  test('填色取第一条命中的规则', () => {
    const view = {
      ...EMPTY_VIEW,
      tints: [
        { id: 'a', field: 2, test: 'equals' as const, operand: '甲类', color: 'blue' as const },
        { id: 'b', field: 0, test: 'filled' as const, operand: '', color: 'red' as const },
      ],
    }
    const [group] = project(SHEET, view)
    const row = group?.rows[0]

    expect(row === undefined ? null : tintOf(fields(SHEET), view, row)).toBe('blue')
  })

  test('删列以后判据跟着搬家，指向消失列的丢掉', () => {
    const view = {
      ...EMPTY_VIEW,
      filters: [
        { id: 'a', field: 1, test: 'filled' as const, operand: '' },
        { id: 'b', field: 3, test: 'filled' as const, operand: '' },
      ],
      hidden: [1, 2],
    }
    const next = retarget(view, removeField(SHEET, 1).moved)

    expect(next.filters.map((filter) => filter.field)).toEqual([2])
    expect(next.hidden).toEqual([1])
  })
})
