import { describe, expect, test } from 'bun:test'
import type { TableSheet } from '@poietica/contract/library'
import {
  duplicateField,
  duplicateRow,
  EMPTY_VIEW,
  fields,
  insertField,
  insertRows,
  project,
  removeField,
  retarget,
  setKind,
  type Test,
  tintOf,
} from './sheet'

const SHEET: TableSheet = {
  header: ['标题', '数字', '单选', '日期'],
  rows: [
    ['乙', '10', '甲类', '2026-01-02'],
    ['甲', '9', '乙类', '2026-01-01'],
    ['丙', '', '甲类', ''],
  ],
  kinds: [null, null, null, null],
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

  test('指定的类型优先于推断，未指定的列继续推断', () => {
    const sheet: TableSheet = { ...SHEET, kinds: ['currency', null, null, null] }

    expect(fields(sheet).map((field) => field.kind)).toEqual([
      'currency',
      'number',
      'select',
      'date',
    ])
  })

  test('setKind 只换类型不碰数据', () => {
    const next = setKind(SHEET, 0, 'phone')

    expect(next.kinds).toEqual(['phone', null, null, null])
    expect(next.rows).toEqual(SHEET.rows)
  })

  test('insertRows 在锚点处插入指定个数的空行', () => {
    const next = insertRows(SHEET, 1, 2)

    expect(next.rows).toEqual([
      ['乙', '10', '甲类', '2026-01-02'],
      ['', '', '', ''],
      ['', '', '', ''],
      ['甲', '9', '乙类', '2026-01-01'],
      ['丙', '', '甲类', ''],
    ])
    expect(next.kinds).toEqual(SHEET.kinds)
  })

  test('duplicateRow 把副本落在原行正下方', () => {
    const next = duplicateRow(SHEET, 0)

    expect(next.rows).toEqual([
      ['乙', '10', '甲类', '2026-01-02'],
      ['乙', '10', '甲类', '2026-01-02'],
      ['甲', '9', '乙类', '2026-01-01'],
      ['丙', '', '甲类', ''],
    ])
  })

  test('货币列按数值排序，字面量退回字典序不断崩', () => {
    const sheet: TableSheet = {
      header: ['价'],
      rows: [['10'], ['9'], ['面议']],
      kinds: ['currency'],
    }
    const view = { ...EMPTY_VIEW, sorts: [{ id: 'a', field: 0, descending: false }] }
    const [group] = project(sheet, view)

    expect(group?.rows.map((row) => row.cells[0])).toEqual(['9', '10', '面议'])
  })

  test.each([
    ['notEquals', ['甲', '丙']],
    ['greaterEquals', ['乙']],
    ['lessEquals', ['乙', '甲']],
  ] as Array<[Test, Array<string>]>)('数字列的 %s 判据', (test, expected) => {
    const view = { ...EMPTY_VIEW, filters: [{ id: 'a', field: 1, test, operand: '10' }] }
    const [group] = project(SHEET, view)

    expect(group?.rows.map((row) => row.cells[0])).toEqual(expected)
  })

  test('文本列的不等于判据', () => {
    const view = {
      ...EMPTY_VIEW,
      filters: [{ id: 'a', field: 0, test: 'notEquals' as const, operand: '甲' }],
    }
    const [group] = project(SHEET, view)

    expect(group?.rows.map((row) => row.cells[0])).toEqual(['乙', '丙'])
  })

  test('insertField 在锚点插入空列，判据跟着搬家', () => {
    const { sheet, moved } = insertField(SHEET, 1, '新字段')

    expect(sheet.header).toEqual(['标题', '新字段', '数字', '单选', '日期'])
    expect(sheet.rows[0]).toEqual(['乙', '', '10', '甲类', '2026-01-02'])
    expect(sheet.kinds).toEqual([null, null, null, null, null])
    expect(moved).toEqual([0, 2, 3, 4])

    const view = {
      ...EMPTY_VIEW,
      filters: [{ id: 'a', field: 1, test: 'filled' as const, operand: '' }],
    }
    const next = retarget(view, moved)

    expect(next.filters.map((filter) => filter.field)).toEqual([2])
  })

  test('duplicateField 把副本列连值带类型落在右侧，列名不撞', () => {
    const typed: TableSheet = { ...SHEET, kinds: ['text', 'number', 'select', 'date'] }
    const { sheet, moved } = duplicateField(typed, 1)

    expect(sheet.header).toEqual(['标题', '数字', '数字 副本', '单选', '日期'])
    expect(sheet.rows[0]).toEqual(['乙', '10', '10', '甲类', '2026-01-02'])
    expect(sheet.kinds).toEqual(['text', 'number', 'number', 'select', 'date'])
    expect(moved).toEqual([0, 1, 3, 4])
  })
})
