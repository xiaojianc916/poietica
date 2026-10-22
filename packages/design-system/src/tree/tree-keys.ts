/*
 * 树的键盘语义（WAI-ARIA Tree View 模式）：一行一个 tab 停靠点，方向键在行之间移焦点。
 * 纯函数：只回答「按了这个键，焦点该去哪 / 该做什么」，开合与打开由调用方去做 —— 这样能脱离 DOM 单测。
 */

export interface TreeKeyRow {
  readonly kind: 'file' | 'folder'
  readonly key: string
  readonly depth: number
  readonly expanded?: boolean
}

export type TreeKeyEffect =
  | { readonly kind: 'focus'; readonly key: string }
  | { readonly kind: 'toggle'; readonly key: string }
  | { readonly kind: 'activate'; readonly key: string }
  | { readonly kind: 'none' }

const NONE: TreeKeyEffect = { kind: 'none' }

function focusAt(rows: readonly TreeKeyRow[], index: number): TreeKeyEffect {
  const row = rows[index]
  return row === undefined ? NONE : { kind: 'focus', key: row.key }
}

/* 向左：展开着的目录先收起；否则跳到父目录（往上找第一行更浅的）。 */
function left(rows: readonly TreeKeyRow[], index: number, row: TreeKeyRow): TreeKeyEffect {
  if (row.kind === 'folder' && row.expanded === true) {
    return { kind: 'toggle', key: row.key }
  }
  for (let at = index - 1; at >= 0; at -= 1) {
    const above = rows[at]
    if (above !== undefined && above.depth < row.depth) {
      return { kind: 'focus', key: above.key }
    }
  }
  return NONE
}

/* 向右：收着的目录展开；展开着的目录进第一个孩子；文件不动。 */
function right(rows: readonly TreeKeyRow[], index: number, row: TreeKeyRow): TreeKeyEffect {
  if (row.kind !== 'folder') {
    return NONE
  }
  if (row.expanded !== true) {
    return { kind: 'toggle', key: row.key }
  }
  const next = rows[index + 1]
  return next !== undefined && next.depth > row.depth ? { kind: 'focus', key: next.key } : NONE
}

export function treeKeyEffect(rows: readonly TreeKeyRow[], focusedKey: string, key: string): TreeKeyEffect {
  const index = rows.findIndex((row) => row.key === focusedKey)
  const row = rows[index]
  if (row === undefined) {
    return NONE
  }
  switch (key) {
    case 'ArrowDown':
      return focusAt(rows, index + 1)
    case 'ArrowUp':
      return focusAt(rows, index - 1)
    case 'Home':
      return focusAt(rows, 0)
    case 'End':
      return focusAt(rows, rows.length - 1)
    case 'ArrowLeft':
      return left(rows, index, row)
    case 'ArrowRight':
      return right(rows, index, row)
    case 'Enter':
    case ' ':
      return row.kind === 'folder' ? { kind: 'toggle', key: row.key } : { kind: 'activate', key: row.key }
    default:
      return NONE
  }
}
