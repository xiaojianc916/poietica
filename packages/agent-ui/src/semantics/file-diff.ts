import { structuredPatch } from 'diff'

import type { ToolContentPart } from './tool-call-content'

/**
 * 一处改动：路径怎么显示，哪些行摆上屏幕，改了多少行。
 *
 * 切 hunk 与编行号交给 jsdiff 的 structuredPatch —— 统一 diff 的排布是被解决过的问题
 * （GNU diffutils 的 unified format），opencode 的分享页读的也是同一个包。这一层不认识
 * React，也不进 markdown：一段围栏里没有行号的位置。
 */

export interface DiffStat {
  readonly added: number
  readonly removed: number
}

export type DiffRowKind = 'added' | 'context' | 'gap' | 'removed'

export interface DiffRow {
  /** 这一行在这张 diff 里的位置，也就是它的身份。 */
  readonly at: number
  readonly kind: DiffRowKind
  /** 行号槽里印的数：删掉的行报旧文件的号，其余报新文件的；断点没有号。 */
  readonly number: number | null
  /** 这一行的内容，不带 +/- 前缀：增删归色带与左沿记号说，字符列因此和编辑器里对齐。 */
  readonly text: string
}

export interface DiffFile {
  readonly path: string
  readonly name: string
  readonly rows: readonly DiffRow[]
  readonly stat: DiffStat
}

/** 上下文行数：git diff 的默认值。 */
const CONTEXT = 3

/*
 * 路径印成正斜杠。Win32 的文件 API 与 Node 的 path 都把它当合法分隔符，所以复制出去照样
 * 能用。只认盘符与 UNC 开头的绝对路径 —— 别的字符串里反斜杠带语义。
 */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/

export function toDisplayPath(text: string): string {
  return WINDOWS_PATH.test(text) ? text.replaceAll('\\', '/') : text
}

/** 最后一段的起点。两个分隔符都切：agent 交回来的路径两种写法都有。 */
function cutOf(path: string): number {
  return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
}

/** 路径的最后一段；末尾就是分隔符时原文比空白有用。 */
export function basename(path: string): string {
  const tail = path.slice(cutOf(path) + 1)

  return tail === '' ? path : tail
}

/** 一行属于哪一边。'\ No newline at end of file' 不是内容，不上屏。 */
function kindOf(line: string): DiffRowKind | null {
  if (line.startsWith('+')) {
    return 'added'
  }

  if (line.startsWith('-')) {
    return 'removed'
  }

  return line.startsWith('\\') ? null : 'context'
}

type Hunk = ReturnType<typeof structuredPatch>['hunks'][number]

/** 摊平一段 hunk：行按屏幕顺序进 rows，返回这一段改了多少行。 */
function spread(hunk: Hunk, rows: DiffRow[]): DiffStat {
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  let added = 0
  let removed = 0

  /* 这一段前面有没显示的行：屏幕上要有个断点，否则两段读成连着的。 */
  if (rows.length > 0 || hunk.newStart > 1) {
    rows.push({ at: rows.length, kind: 'gap', number: null, text: '' })
  }

  for (const line of hunk.lines) {
    const kind = kindOf(line)

    if (kind === null) {
      continue
    }

    if (kind === 'added') {
      added += 1
      rows.push({ at: rows.length, kind, number: newLine, text: line.slice(1) })
      newLine += 1

      continue
    }

    if (kind === 'removed') {
      removed += 1
      rows.push({ at: rows.length, kind, number: oldLine, text: line.slice(1) })
      oldLine += 1

      continue
    }

    rows.push({ at: rows.length, kind, number: newLine, text: line.slice(1) })
    oldLine += 1
    newLine += 1
  }

  return { added, removed }
}

function fileOf(part: Extract<ToolContentPart, { type: 'diff' }>): DiffFile {
  const path = toDisplayPath(part.path)
  const patch = structuredPatch(path, path, part.oldText ?? '', part.newText, '', '', {
    context: CONTEXT,
  })

  const rows: DiffRow[] = []
  let added = 0
  let removed = 0

  for (const hunk of patch.hunks) {
    const stat = spread(hunk, rows)

    added += stat.added
    removed += stat.removed
  }

  return {
    path,
    name: basename(path),
    rows,
    stat: { added, removed },
  }
}

const NONE: readonly DiffFile[] = []

const FILES = new WeakMap<readonly ToolContentPart[], readonly DiffFile[]>()

/**
 * 这一面里的每一处改动，按片段数组记一次。
 *
 * 键是投影交回的那个数组，它的引用由 toToolContentParts 的记账保证稳定，所以同一份内容
 * 不会被比对两遍 —— Myers 差分不便宜，而这条路在渲染路径上。
 */
export function toDiffFiles(parts: readonly ToolContentPart[]): readonly DiffFile[] {
  const held = FILES.get(parts)

  if (held !== undefined) {
    return held
  }

  const files: DiffFile[] = []

  for (const part of parts) {
    if (part.type === 'diff') {
      const file = fileOf(part)

      /* 前后一模一样：没有一行可画，这次调用也就不是一处改动。 */
      if (file.rows.length > 0) {
        files.push(file)
      }
    }
  }

  const found: readonly DiffFile[] = files.length === 0 ? NONE : files

  FILES.set(parts, found)

  return found
}

/** 这次调用改了多少行；与屏幕上那些行同一份来源。 */
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
