import type { SheetFieldKind, TableSheet } from '@poietica/contract/library'

/**
 * 列类型词汇的唯一产地是 Rust（SheetFieldKind，经 IPC 生成），这里只起别名。
 * 未指定的列（kinds 里是 null）走下面的值推断：CSV 没有 schema，第二份 schema
 * 就是第二份真相，所以推断逻辑与落盘的类型注解共存（ADR 0043）。
 */
export type FieldKind = SheetFieldKind

export interface Field {
  readonly name: string
  readonly kind: FieldKind
}

/** 判据。筛选与填色共用它，分组与排序各自只多一个维度。 */
export type Test =
  | 'any'
  | 'filled'
  | 'empty'
  | 'contains'
  | 'equals'
  | 'notEquals'
  | 'greater'
  | 'greaterEquals'
  | 'less'
  | 'lessEquals'

export interface Condition {
  readonly id: string
  readonly field: number
  readonly test: Test
  readonly operand: string
}

export type TintColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'gray'

export interface Tint extends Condition {
  readonly color: TintColor
}

export interface Sort {
  readonly id: string
  readonly field: number
  readonly descending: boolean
}

export interface Group {
  readonly id: string
  readonly field: number
}

export type RowHeight = 'default' | 'medium' | 'relaxed' | 'wide'

export interface SheetView {
  readonly filters: readonly Condition[]
  readonly sorts: readonly Sort[]
  readonly groups: readonly Group[]
  readonly tints: readonly Tint[]
  readonly hidden: readonly number[]
  readonly rowHeight: RowHeight
  readonly find: string
}

export const EMPTY_VIEW: SheetView = {
  filters: [],
  sorts: [],
  groups: [],
  tints: [],
  hidden: [],
  rowHeight: 'default',
  find: '',
}

/** 结构性改动的结果：新表，以及旧列号 → 新列号的搬家表（-1 表示这列没了）。 */
export interface Restructure {
  readonly sheet: TableSheet
  readonly moved: readonly number[]
}

/** 不同取值不超过这个数的列才算单选，再多就是自由文本。 */
const SELECT_DISTINCT_LIMIT = 8
/** ECMAScript Date Time String Format 里的日历日形状。 */
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/

function column(sheet: TableSheet, index: number): readonly string[] {
  return sheet.rows.map((row) => row[index] ?? '')
}

function kindOf(values: readonly string[]): FieldKind {
  const filled = values.filter((value) => value.trim() !== '')

  if (filled.length === 0) {
    return 'text'
  }
  if (filled.every((value) => Number.isFinite(Number(value)))) {
    return 'number'
  }
  if (filled.every((value) => CALENDAR_DAY.test(value) && Number.isFinite(Date.parse(value)))) {
    return 'date'
  }

  const distinct = new Set(filled)

  return distinct.size <= SELECT_DISTINCT_LIMIT && distinct.size < filled.length ? 'select' : 'text'
}

export function fields(sheet: TableSheet): readonly Field[] {
  return sheet.header.map((name, index) => ({
    name,
    kind: sheet.kinds[index] ?? kindOf(column(sheet, index)),
  }))
}

/** 某一列出现过的取值，供判据的取值下拉用。 */
export function options(sheet: TableSheet, index: number): readonly string[] {
  return [...new Set(column(sheet, index).filter((value) => value.trim() !== ''))].sort(
    (left, right) => left.localeCompare(right),
  )
}

function compare(kind: FieldKind, left: string, right: string): number {
  if (left === right) {
    return 0
  }
  if (left === '') {
    return 1
  }
  if (right === '') {
    return -1
  }
  if (kind === 'number' || kind === 'currency') {
    /* 指定了数字/货币但格子里有字面量时退回字典序：NaN 排不出先后。 */
    const delta = Number(left) - Number(right)

    return Number.isNaN(delta) ? left.localeCompare(right) : delta
  }
  if (kind === 'date') {
    const delta = Date.parse(left) - Date.parse(right)

    return Number.isNaN(delta) ? left.localeCompare(right) : delta
  }

  return left.localeCompare(right)
}

function passes(kind: FieldKind, cell: string, test: Test, operand: string): boolean {
  switch (test) {
    case 'any':
      return true
    case 'filled':
      return cell.trim() !== ''
    case 'empty':
      return cell.trim() === ''
    case 'contains':
      return cell.toLowerCase().includes(operand.toLowerCase())
    case 'equals':
      return cell === operand
    case 'notEquals':
      return cell !== operand
    case 'greater':
      return operand !== '' && cell !== '' && compare(kind, cell, operand) > 0
    case 'greaterEquals':
      return operand !== '' && cell !== '' && compare(kind, cell, operand) >= 0
    case 'less':
      return operand !== '' && cell !== '' && compare(kind, cell, operand) < 0
    case 'lessEquals':
      return operand !== '' && cell !== '' && compare(kind, cell, operand) <= 0
  }
}

export interface SheetRow {
  /** 底层行号。筛选与排序只改可见顺序，写回永远落在这一行。 */
  readonly index: number
  readonly cells: readonly string[]
}

export interface SheetGroup {
  readonly label: string
  readonly rows: readonly SheetRow[]
}

/** 唯一的投影：筛选 → 检索 → 排序 → 分组。界面上的每一行都从这里来。 */
export function project(sheet: TableSheet, view: SheetView): readonly SheetGroup[] {
  const kinds = fields(sheet).map((field) => field.kind)
  const needle = view.find.trim().toLowerCase()
  const visible: SheetRow[] = []

  for (const [index, row] of sheet.rows.entries()) {
    const cells = sheet.header.map((_, at) => row[at] ?? '')
    const kept = view.filters.every((filter) =>
      passes(kinds[filter.field] ?? 'text', cells[filter.field] ?? '', filter.test, filter.operand),
    )
    const found =
      needle === '' ||
      cells.some((cell, at) => !view.hidden.includes(at) && cell.toLowerCase().includes(needle))

    if (kept && found) {
      visible.push({ index, cells })
    }
  }

  /* Array.prototype.sort 按 ECMA-262 是稳定排序，所以倒着逐键排就是多键排序。 */
  for (const sort of [...view.sorts].reverse()) {
    visible.sort((left, right) => {
      const order = compare(
        kinds[sort.field] ?? 'text',
        left.cells[sort.field] ?? '',
        right.cells[sort.field] ?? '',
      )

      return sort.descending ? -order : order
    })
  }

  if (view.groups.length === 0) {
    return [{ label: '', rows: visible }]
  }

  const grouped = new Map<string, SheetRow[]>()

  for (const row of visible) {
    const label = view.groups
      .map((group) => row.cells[group.field] ?? '')
      .map((value) => (value.trim() === '' ? '（空）' : value))
      .join(' / ')
    const bucket = grouped.get(label)

    if (bucket === undefined) {
      grouped.set(label, [row])
    } else {
      bucket.push(row)
    }
  }

  return [...grouped].map(([label, rows]) => ({ label, rows }))
}

/** 命中的第一条填色规则说了算。 */
export function tintOf(list: readonly Field[], view: SheetView, row: SheetRow): TintColor | null {
  for (const tint of view.tints) {
    const kind = list[tint.field]?.kind ?? 'text'

    if (passes(kind, row.cells[tint.field] ?? '', tint.test, tint.operand)) {
      return tint.color
    }
  }

  return null
}

export function setCell(sheet: TableSheet, row: number, field: number, value: string): TableSheet {
  return {
    header: sheet.header,
    rows: sheet.rows.map((cells, index) =>
      index === row
        ? sheet.header.map((_, at) => (at === field ? value : (cells[at] ?? '')))
        : cells,
    ),
    kinds: sheet.kinds,
  }
}

export function addRow(sheet: TableSheet): TableSheet {
  return {
    header: sheet.header,
    rows: [...sheet.rows, sheet.header.map(() => '')],
    kinds: sheet.kinds,
  }
}

export function removeRow(sheet: TableSheet, row: number): TableSheet {
  return {
    header: sheet.header,
    rows: sheet.rows.filter((_, index) => index !== row),
    kinds: sheet.kinds,
  }
}

/** 在 at 处插入 count 个空行。count 归一到 1…99：输入框只负责显示。 */
export function insertRows(sheet: TableSheet, at: number, count: number): TableSheet {
  const total = Math.max(1, Math.min(99, Math.floor(count) || 1))
  const anchor = Math.max(0, Math.min(sheet.rows.length, at))

  return {
    header: sheet.header,
    rows: [
      ...sheet.rows.slice(0, anchor),
      ...Array.from({ length: total }, () => sheet.header.map(() => '')),
      ...sheet.rows.slice(anchor),
    ],
    kinds: sheet.kinds,
  }
}

/** 创建副本落在原行正下方。不存在的行原样返回：右键菜单的序号是可见序号。 */
export function duplicateRow(sheet: TableSheet, row: number): TableSheet {
  const source = sheet.rows[row]

  if (source === undefined) {
    return sheet
  }

  const copy = sheet.header.map((_, at) => source[at] ?? '')

  return {
    header: sheet.header,
    rows: [...sheet.rows.slice(0, row + 1), copy, ...sheet.rows.slice(row + 1)],
    kinds: sheet.kinds,
  }
}

export function renameField(sheet: TableSheet, field: number, name: string): TableSheet {
  return {
    header: sheet.header.map((current, index) => (index === field ? name : current)),
    rows: sheet.rows,
    kinds: sheet.kinds,
  }
}

/** 指定一列的类型。落盘走边车，见 ADR 0043。 */
export function setKind(sheet: TableSheet, field: number, kind: FieldKind): TableSheet {
  return {
    header: sheet.header,
    rows: sheet.rows,
    kinds: sheet.header.map((_, index) => (index === field ? kind : (sheet.kinds[index] ?? null))),
  }
}

/** 新字段的默认名：跟现有列不撞。 */
export function nextFieldName(sheet: TableSheet): string {
  let ordinal = sheet.header.length + 1
  let name = `字段 ${ordinal}`

  while (sheet.header.includes(name)) {
    ordinal += 1
    name = `字段 ${ordinal}`
  }

  return name
}

export function addField(sheet: TableSheet, name: string): Restructure {
  return {
    sheet: {
      header: [...sheet.header, name],
      rows: sheet.rows.map((cells) => [...sheet.header.map((_, at) => cells[at] ?? ''), '']),
      kinds: [...sheet.kinds, null],
    },
    moved: sheet.header.map((_, index) => index),
  }
}

/** 在 at 处插入空列。旧列号 → 新列号的搬家表照常给出，视图判据跟着走。 */
export function insertField(sheet: TableSheet, at: number, name: string): Restructure {
  const anchor = Math.max(0, Math.min(sheet.header.length, at))

  return {
    sheet: {
      header: [...sheet.header.slice(0, anchor), name, ...sheet.header.slice(anchor)],
      rows: sheet.rows.map((cells) => [
        ...sheet.header.slice(0, anchor).map((_, index) => cells[index] ?? ''),
        '',
        ...sheet.header.slice(anchor).map((_, offset) => cells[anchor + offset] ?? ''),
      ]),
      kinds: [...sheet.kinds.slice(0, anchor), null, ...sheet.kinds.slice(anchor)],
    },
    moved: sheet.header.map((_, index) => (index < anchor ? index : index + 1)),
  }
}

/** 创建副本列落在原列正右方，列名与类型一起带过去，列名不跟现有列撞。 */
export function duplicateField(sheet: TableSheet, field: number): Restructure {
  const source = sheet.header[field]

  if (source === undefined) {
    return { sheet, moved: sheet.header.map((_, index) => index) }
  }

  const anchor = field + 1
  let name = `${source} 副本`
  let ordinal = 2

  while (sheet.header.includes(name)) {
    name = `${source} 副本 ${ordinal}`
    ordinal += 1
  }

  return {
    sheet: {
      header: [...sheet.header.slice(0, anchor), name, ...sheet.header.slice(anchor)],
      rows: sheet.rows.map((cells) => [
        ...sheet.header.slice(0, anchor).map((_, index) => cells[index] ?? ''),
        cells[field] ?? '',
        ...sheet.header.slice(anchor).map((_, offset) => cells[anchor + offset] ?? ''),
      ]),
      kinds: [
        ...sheet.kinds.slice(0, anchor),
        sheet.kinds[field] ?? null,
        ...sheet.kinds.slice(anchor),
      ],
    },
    moved: sheet.header.map((_, index) => (index < anchor ? index : index + 1)),
  }
}

export function removeField(sheet: TableSheet, field: number): Restructure {
  const order = sheet.header.map((_, index) => index).filter((index) => index !== field)

  return {
    sheet: {
      header: order.map((at) => sheet.header[at] ?? ''),
      rows: sheet.rows.map((cells) => order.map((at) => cells[at] ?? '')),
      kinds: order.map((at) => sheet.kinds[at] ?? null),
    },
    moved: sheet.header.map((_, index) => order.indexOf(index)),
  }
}

export function moveField(sheet: TableSheet, from: number, to: number): Restructure {
  const order = sheet.header.map((_, index) => index)
  const [taken] = order.splice(from, 1)

  if (taken === undefined) {
    return { sheet, moved: order }
  }

  order.splice(to, 0, taken)

  return {
    sheet: {
      header: order.map((at) => sheet.header[at] ?? ''),
      rows: sheet.rows.map((cells) => order.map((at) => cells[at] ?? '')),
      kinds: order.map((at) => sheet.kinds[at] ?? null),
    },
    moved: sheet.header.map((_, index) => order.indexOf(index)),
  }
}

/** 列号变了以后，视图里指向列的判据跟着搬家；指向消失列的整条丢掉。 */
export function retarget(view: SheetView, moved: readonly number[]): SheetView {
  const at = (field: number): number => moved[field] ?? -1
  const kept = <T extends { readonly field: number }>(rows: readonly T[]): T[] =>
    rows.filter((row) => at(row.field) >= 0).map((row) => ({ ...row, field: at(row.field) }))

  return {
    ...view,
    filters: kept(view.filters),
    sorts: kept(view.sorts),
    groups: kept(view.groups),
    tints: kept(view.tints),
    hidden: view.hidden.map(at).filter((index) => index >= 0),
  }
}
