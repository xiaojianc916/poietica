import { diffWordsWithSpace, parsePatch, structuredPatch } from 'diff'

/*
 * 统一 diff 的语义：一份补丁、或一对正文 → 屏幕上的那些行。
 *
 * 切 hunk、编行号、算词级差分交给 jsdiff（unified format 是 GNU diffutils 定下的、
 * 被解决过的问题）；折叠、行的身份与加减账目是这个产品自己的规则，全仓只有这一份。
 * 不认 React 与 DOM，能在 Node 里单测。
 */

/** 一截正文在两套主题下的颜色；填色的是消费者，这一层只留位置。 */
export interface PieceColor {
  readonly light: string
  readonly dark: string
}

/** 正文的切分：emphasis 是与对侧不同的那一截。 */
export interface DiffPiece {
  readonly at: number
  readonly text: string
  readonly emphasis: boolean
  readonly color: PieceColor | null
}

export type DiffRowKind = 'added' | 'context' | 'gap' | 'removed'

export interface DiffRow {
  /** 在所属数组里的位置，也就是这一行的身份。 */
  readonly at: number
  readonly kind: DiffRowKind
  /** 行号槽里印的数：删掉的行报旧文件的号，其余报新文件的；折叠带没有号。 */
  readonly number: number | null
  /** 不带 +/- 前缀的正文；折叠带是空串。 */
  readonly text: string
  /** text 的切分，拼回来与 text 一字不差。 */
  readonly pieces: readonly DiffPiece[]
  /** 折起来的行数；只有折叠带不是 0。 */
  readonly lines: number
  /** 折起来的那些行；补丁没带上下文时为空，也就展不开。 */
  readonly hidden: readonly DiffRow[]
}

export interface DiffStat {
  readonly added: number
  readonly removed: number
}

export interface DiffFile {
  readonly path: string
  /** git 只说了两侧不同：没有可对比的文本。 */
  readonly binary: boolean
  readonly rows: readonly DiffRow[]
  readonly stat: DiffStat
}

/* 路径印成正斜杠。Win32 的文件 API 与 Node 的 path 都把它当合法分隔符。 */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/

export function toDisplayPath(text: string): string {
  return WINDOWS_PATH.test(text) ? text.replaceAll('\\', '/') : text
}

/** 最后一段的起点。两个分隔符都切。 */
function cutOf(path: string): number {
  return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
}

/** 路径的最后一段；末尾就是分隔符时原文比空白有用。 */
export function basename(path: string): string {
  const tail = path.slice(cutOf(path) + 1)

  return tail === '' ? path : tail
}

/** 改动两侧各留几行未改动的 —— git 默认的 -U3 就是这个数。 */
const KEPT = 3
const HEADER = 'diff --git '
const SECTION = /^(?=diff --git )/m
const NO_ROWS: readonly DiffRow[] = []
const NO_PIECES: readonly DiffPiece[] = []

type Patch = ReturnType<typeof parsePatch>[number]
type Hunk = Patch['hunks'][number]

/** 摊平后的一行；折叠只认 context，所以这一层不带 gap。 */
interface Line {
  readonly kind: Exclude<DiffRowKind, 'gap'>
  readonly number: number
  readonly text: string
}

type Item = Line | { readonly hole: number }

interface Count {
  added: number
  removed: number
}

/** 一对正文算出一处改动。 */
export function computeFile(path: string, oldText: string, newText: string): DiffFile {
  const patch = structuredPatch(path, path, oldText, newText, '', '', { context: KEPT })

  return fileOf(path, patch.hunks, false, false)
}

/** 一份多文件补丁摊成每一处改动；emphasis 打开时做词级强调。 */
export function parseUnifiedPatch(patch: string, emphasis: boolean): readonly DiffFile[] {
  const files: DiffFile[] = []

  for (const section of patch.split(SECTION)) {
    if (!section.startsWith(HEADER)) {
      continue
    }

    const [parsed] = parsePatch(section)
    const binary = section.includes('\nBinary files ')

    files.push(fileOf(pathOf(parsed, section), parsed?.hunks ?? [], binary, emphasis))
  }

  return files
}

/** 一批改动一共改了多少行；空批不是一处改动。 */
export function diffStatOf(files: readonly DiffFile[]): DiffStat | null {
  if (files.length === 0) {
    return null
  }

  let added = 0
  let removed = 0

  for (const file of files) {
    added += file.stat.added
    removed += file.stat.removed
  }

  return { added, removed }
}

function fileOf(
  path: string,
  hunks: readonly Hunk[],
  binary: boolean,
  emphasis: boolean,
): DiffFile {
  const count: Count = { added: 0, removed: 0 }
  const rows = fold(flatten(hunks, count))

  return {
    binary,
    path,
    rows: emphasis ? emphasised(rows) : rows,
    stat: { added: count.added, removed: count.removed },
  }
}

/* hunk 摊成行。加减的账在这一趟记完，不必再问一次 numstat。 */
function flatten(hunks: readonly Hunk[], count: Count): readonly Item[] {
  const items: Item[] = []
  let next = 1

  for (const hunk of hunks) {
    if (hunk.newStart > next) {
      items.push({ hole: hunk.newStart - next })
    }

    let oldLine = hunk.oldStart
    let newLine = hunk.newStart

    for (const line of hunk.lines) {
      const mark = line.slice(0, 1)
      const text = line.slice(1)

      /* 「\ No newline at end of file」不是一行内容。 */
      if (mark === '\\') {
        continue
      }

      if (mark === '+') {
        items.push({ kind: 'added', number: newLine, text })
        newLine += 1
        count.added += 1
        continue
      }

      if (mark === '-') {
        items.push({ kind: 'removed', number: oldLine, text })
        oldLine += 1
        count.removed += 1
        continue
      }

      items.push({ kind: 'context', number: newLine, text })
      newLine += 1
      oldLine += 1
    }

    next = newLine
  }

  return items
}

/* 长段未改动行折起来：改动两侧各留 KEPT 行，中间收进一条折叠带。 */
function fold(items: readonly Item[]): readonly DiffRow[] {
  const rows: DiffRow[] = []
  let context: Line[] = []

  const flush = (last: boolean): void => {
    const front = rows.length === 0 ? 0 : KEPT
    const back = last ? 0 : KEPT

    if (context.length <= front + back) {
      for (const line of context) {
        rows.push(rowOf(line, rows.length))
      }

      context = []

      return
    }

    for (const line of context.slice(0, front)) {
      rows.push(rowOf(line, rows.length))
    }

    const edge = context.length - back

    rows.push(gapOf(rows.length, edge - front, context.slice(front, edge)))

    for (const line of context.slice(edge)) {
      rows.push(rowOf(line, rows.length))
    }

    context = []
  }

  for (const item of items) {
    if ('hole' in item) {
      flush(false)
      rows.push(gapOf(rows.length, item.hole, []))
      continue
    }

    if (item.kind === 'context') {
      context.push(item)
      continue
    }

    flush(false)
    rows.push(rowOf(item, rows.length))
  }

  flush(true)

  return rows
}

/* 等长的一段删除紧跟一段新增才对得上行；不等长就不猜，整行算改动。 */
function emphasised(rows: readonly DiffRow[]): readonly DiffRow[] {
  const held = [...rows]
  let index = 0

  while (index < held.length) {
    const removed = streak(held, index, 'removed')
    const added = streak(held, index + removed, 'added')

    if (removed > 0 && removed === added) {
      for (let offset = 0; offset < removed; offset += 1) {
        pair(held, index + offset, index + removed + offset)
      }
    }

    const span = removed + added

    index += span > 0 ? span : 1
  }

  return held
}

function streak(rows: readonly DiffRow[], from: number, kind: DiffRowKind): number {
  let length = 0

  while (rows[from + length]?.kind === kind) {
    length += 1
  }

  return length
}

/* 一对行的词级差分：jsdiff 的变更表按两条通道拆，各自拼回来就是原文。 */
function pair(rows: DiffRow[], before: number, after: number): void {
  const removed = rows[before]
  const added = rows[after]

  if (removed === undefined || added === undefined) {
    return
  }

  const left: DiffPiece[] = []
  const right: DiffPiece[] = []

  for (const part of diffWordsWithSpace(removed.text, added.text)) {
    if (part.added !== true) {
      push(left, part.value, part.removed === true)
    }

    if (part.removed !== true) {
      push(right, part.value, part.added === true)
    }
  }

  rows[before] = { ...removed, pieces: left }
  rows[after] = { ...added, pieces: right }
}

/* at 是这一截在行内的起点：语法着色按它与词元求交。 */
function push(pieces: DiffPiece[], text: string, emphasis: boolean): void {
  if (text === '') {
    return
  }

  const last = pieces.at(-1)
  const at = last === undefined ? 0 : last.at + last.text.length

  pieces.push({ at, color: null, emphasis, text })
}

function wholePieces(text: string): readonly DiffPiece[] {
  return [{ at: 0, color: null, emphasis: false, text }]
}

function rowOf(line: Line, at: number): DiffRow {
  return {
    at,
    hidden: NO_ROWS,
    kind: line.kind,
    lines: 0,
    number: line.number,
    pieces: wholePieces(line.text),
    text: line.text,
  }
}

function gapOf(at: number, lines: number, hidden: readonly Line[]): DiffRow {
  return {
    at,
    hidden: hidden.map((line, index) => rowOf(line, index)),
    kind: 'gap',
    lines,
    number: null,
    pieces: NO_PIECES,
    text: '',
  }
}

/* 路径的三个来源按可信度排。二进制节没有 ---/+++ 两行，路径只在节头上。 */
function pathOf(parsed: Patch | undefined, section: string): string {
  return sidePath(parsed?.newFileName) ?? sidePath(parsed?.oldFileName) ?? headerPath(section)
}

/* /dev/null 是「这一侧不存在」，不是路径；a/ 与 b/ 是 diff 的前缀。 */
function sidePath(value: string | undefined): string | null {
  if (value === undefined) {
    return null
  }

  const held = value.trim()

  if (held === '' || held === '/dev/null') {
    return null
  }

  return held.startsWith('a/') || held.startsWith('b/') ? held.slice(2) : held
}

function headerPath(section: string): string {
  const [header = ''] = section.split('\n')
  const cut = header.lastIndexOf(' b/')

  return cut < 0 ? header.slice(HEADER.length) : header.slice(cut + 3)
}
