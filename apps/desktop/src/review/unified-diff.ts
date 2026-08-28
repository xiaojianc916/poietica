/*
 * 统一补丁 → 审查文件模型。
 *
 * 唯一输入是 git 的多文件 unified diff：文件头给路径，@@ 表头给两侧起点与行数，
 * 行首字符给种类。加减行数在这里数出，不再另问一次 numstat。纯函数，能在 Node
 * 里单测。
 */
export type DiffRowKind = 'added' | 'context' | 'removed'
/** 两套主题各一个十六进制色：取哪一套由 review-pane.css 说。 */
export interface PieceColor {
  readonly light: string
  readonly dark: string
}
/** 一行正文切成片段：emphasis 是与对侧不同的那一截，color 由 syntax 着色时填上。 */
export interface DiffPiece {
  readonly at: number
  readonly text: string
  readonly emphasis: boolean
  readonly color: PieceColor | null
}
export interface DiffRow {
  readonly kind: DiffRowKind
  readonly oldLine: number | null
  readonly newLine: number | null
  readonly pieces: readonly DiffPiece[]
}
/** 一段折起来的未改动行。rows 为空表示这一段没有随补丁取回，展不开。 */
export interface DiffGap {
  readonly id: string
  readonly lines: number
  readonly rows: readonly DiffRow[]
}
export type DiffBand =
  | { readonly kind: 'rows'; readonly rows: readonly DiffRow[] }
  | { readonly kind: 'gap'; readonly gap: DiffGap }
export interface ReviewFile {
  readonly path: string
  readonly additions: number
  readonly deletions: number
  readonly binary: boolean
  readonly bands: readonly DiffBand[]
  /** 这一文件的补丁原文，「复制 git apply 命令」按它拼。 */
  readonly patch: string
}
/** 改动两侧各留这么多未改动行，多出来的折起来 —— 与 git 默认的 -U3 同一个数。 */
const KEPT = 3
const RANGE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/
const TOKEN = /[\p{L}\p{N}_$]+|\s+|[^\p{L}\p{N}_$\s]/gu
type Hole = { readonly hole: number; readonly at: number }
type Item = DiffRow | Hole
export function reviewFiles(patch: string, wordDiff: boolean): readonly ReviewFile[] {
  const found: ReviewFile[] = []
  for (const section of sections(patch)) {
    found.push(file(section, wordDiff))
  }
  return found
}
/* 一份补丁里每个 diff --git 起一节；头一节之前的东西不属于任何文件。 */
function sections(patch: string): readonly (readonly string[])[] {
  const found: string[][] = []
  let open: string[] | null = null
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      open = [line]
      found.push(open)
      continue
    }
    open?.push(line)
  }
  return found
}
function file(lines: readonly string[], wordDiff: boolean): ReviewFile {
  const items: Item[] = []
  let source: string | null = null
  let target: string | null = null
  let binary = false
  let additions = 0
  let deletions = 0
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const line of lines) {
    if (line.startsWith('--- ')) {
      source = side(line.slice(4))
      continue
    }
    if (line.startsWith('+++ ')) {
      target = side(line.slice(4))
      continue
    }
    if (line.startsWith('Binary files ')) {
      binary = true
      continue
    }
    const range = RANGE.exec(line)
    if (range !== null) {
      const nextNew = Number(range[2])
      /* 两段 hunk 之间的未改动行没随补丁回来：记下空洞的长度，不假装有它们。 */
      if (inHunk && nextNew > newLine) {
        items.push({ at: newLine, hole: nextNew - newLine })
      }
      oldLine = Number(range[1])
      newLine = nextNew
      inHunk = true
      continue
    }
    if (!inHunk) {
      continue
    }
    const pieces = plain(line.slice(1))
    if (line.startsWith('+')) {
      items.push({ kind: 'added', newLine, oldLine: null, pieces })
      newLine += 1
      additions += 1
      continue
    }
    if (line.startsWith('-')) {
      items.push({ kind: 'removed', newLine: null, oldLine, pieces })
      oldLine += 1
      deletions += 1
      continue
    }
    if (line.startsWith(' ')) {
      items.push({ kind: 'context', newLine, oldLine, pieces })
      oldLine += 1
      newLine += 1
    }
  }
  return {
    additions,
    bands: banded(wordDiff ? emphasised(items) : items),
    binary,
    deletions,
    patch: lines.join('\n'),
    path: target ?? source ?? headerPath(lines[0] ?? ''),
  }
}
/* /dev/null 是「另一侧不存在」，不是路径；a/ 与 b/ 是 diff 的前缀。 */
function side(value: string): string | null {
  const held = value.trim()
  if (held === '/dev/null') {
    return null
  }
  return held.startsWith('a/') || held.startsWith('b/') ? held.slice(2) : held
}
/* 二进制文件没有 ---/+++，路径只能从 diff --git 那一行取。 */
function headerPath(header: string): string {
  const cut = header.lastIndexOf(' b/')
  return cut < 0 ? header.slice('diff --git '.length) : header.slice(cut + 3)
}
function plain(text: string): readonly DiffPiece[] {
  return [{ at: 0, color: null, emphasis: false, text }]
}
/* 等长的一段删除紧接一段新增才对得上行；不等长就不猜，整行算改动。 */
function emphasised(items: readonly Item[]): readonly Item[] {
  const held = [...items]
  for (let index = 0; index < held.length; index += 1) {
    const removed = streak(held, index, 'removed')
    if (removed === 0) {
      continue
    }
    const added = streak(held, index + removed, 'added')
    if (added === removed) {
      for (let offset = 0; offset < removed; offset += 1) {
        const before = held[index + offset] as DiffRow
        const after = held[index + removed + offset] as DiffRow
        const narrowed = narrow(rowText(before.pieces), rowText(after.pieces))
        held[index + offset] = { ...before, pieces: narrowed.before }
        held[index + removed + offset] = { ...after, pieces: narrowed.after }
      }
    }
    index += removed + added - 1
  }
  return held
}
function streak(items: readonly Item[], from: number, kind: DiffRowKind): number {
  let length = 0
  while (from + length < items.length) {
    const item = items[from + length]
    if (item === undefined || !('kind' in item) || item.kind !== kind) {
      break
    }
    length += 1
  }
  return length
}
/** 片段拼回整行正文：词级比较与语法着色读同一个。 */
export function rowText(pieces: readonly DiffPiece[]): string {
  return pieces.map((piece) => piece.text).join('')
}
/* 按词元切开取公共前后缀：中间那一截就是这两行真正不同的地方。 */
function narrow(
  before: string,
  after: string,
): { readonly before: readonly DiffPiece[]; readonly after: readonly DiffPiece[] } {
  const left = before.match(TOKEN) ?? []
  const right = after.match(TOKEN) ?? []
  let head = 0
  while (head < left.length && head < right.length && left[head] === right[head]) {
    head += 1
  }
  let tail = 0
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) {
    tail += 1
  }
  return { after: parted(right, head, tail), before: parted(left, head, tail) }
}
/* 空段不进列表：三段里通常只有一段有内容。 */
function parted(parts: readonly string[], head: number, tail: number): readonly DiffPiece[] {
  const lead = parts.slice(0, head).join('')
  const middle = parts.slice(head, parts.length - tail).join('')
  const trail = parts.slice(parts.length - tail).join('')
  const found: DiffPiece[] = []
  if (lead !== '') {
    found.push({ at: 0, color: null, emphasis: false, text: lead })
  }
  if (middle !== '') {
    found.push({ at: lead.length, color: null, emphasis: true, text: middle })
  }
  if (trail !== '') {
    found.push({ at: lead.length + middle.length, color: null, emphasis: false, text: trail })
  }
  return found
}
/* 长段未改动行折成一条带子：改动两侧各留 KEPT 行，其余收进 gap。 */
function banded(items: readonly Item[]): readonly DiffBand[] {
  const bands: DiffBand[] = []
  let pending: DiffRow[] = []
  let context: DiffRow[] = []
  const flushRows = (): void => {
    if (pending.length > 0) {
      bands.push({ kind: 'rows', rows: pending })
      pending = []
    }
  }
  const flushContext = (last: boolean): void => {
    const head = pending.length === 0 && bands.length === 0 ? 0 : KEPT
    const tail = last ? 0 : KEPT
    if (context.length <= head + tail) {
      pending.push(...context)
      context = []
      return
    }
    const hidden = context.slice(head, context.length - tail)
    pending.push(...context.slice(0, head))
    flushRows()
    bands.push({ gap: gapOf(hidden[0]?.newLine ?? 0, hidden), kind: 'gap' })
    pending.push(...context.slice(context.length - tail))
    context = []
  }
  for (const item of items) {
    if ('hole' in item) {
      flushContext(false)
      flushRows()
      bands.push({ gap: { id: `h${String(item.at)}`, lines: item.hole, rows: [] }, kind: 'gap' })
      continue
    }
    if (item.kind === 'context') {
      context.push(item)
      continue
    }
    flushContext(false)
    pending.push(item)
  }
  flushContext(true)
  flushRows()
  return bands
}
function gapOf(at: number, rows: readonly DiffRow[]): DiffGap {
  return { id: `g${String(at)}`, lines: rows.length, rows }
}
