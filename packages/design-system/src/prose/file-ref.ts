import { knownFileMarkOf } from '../mark/file-type-mark'

/*
 * 正文里的「本地文件引用」。纯函数，不认 React。
 *
 * 模型把文件写成链接（`[review-pane.tsx](C:\repo\src\review-pane.tsx)`、`file:///…`、相对路径 `src/a.ts#L12`）或行内代码
 * （`src/a.ts:12`）。这些地址浏览器不认：净化链要么把它摘成 `[blocked]`，要么当成网页开到外部浏览器。这里先认出来，
 * 改写成本产品自己的 `poietica-file:` 地址；画的那一层（file-link.tsx）再按它画成带文件图标的链接，点了交给宿主去开。
 */

export interface FileRef {
  /** 写在正文里的路径：绝对（Windows / UNC / POSIX）或相对（相对于对话的工作区，由宿主解析）。分隔符原样保留。 */
  readonly path: string
  readonly line: number | null
  readonly column: number | null
}

export const FILE_HREF_PREFIX = 'poietica-file:'

/* `C:\` `C:/`；`\\server\share`；scheme 至少两个字母（单个字母是盘符）。 */
const DRIVE = /^[A-Za-z]:[\\/]/u
const UNC = /^\\\\[^\\/]/u
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/u
/* `#L12`、`#L12C5`、`#L12-L20`（GitHub 的写法）。 */
const HASH_LINE = /#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/u
/* `:12`、`:12:5`（编译器与 grep 的写法）。盘符后面跟的是分隔符不是数字，所以不会误吃 `C:`。 */
const COLON_LINE = /:(\d+)(?::(\d+))?$/u
/* 文件名里不可能有的字：出现了就不是路径（引号、尖括号、竖线、通配符、换行）。 */
const NOT_PATH = /["<>|*?\n\r\t`]/u
/* 行内代码里裸文件名的后缀若是这些，多半是成员访问（console.log、process.env）而不是文件。 */
const AMBIGUOUS_SUFFIX = new Set(['cfg', 'conf', 'config', 'db', 'env', 'key', 'lib', 'lock', 'log'])

function positive(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const value = Number.parseInt(raw, 10)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function withLine(raw: string): FileRef {
  const hash = HASH_LINE.exec(raw)
  if (hash !== null) {
    return { path: raw.slice(0, hash.index), line: positive(hash[1]), column: positive(hash[2]) }
  }
  const colon = COLON_LINE.exec(raw)
  if (colon !== null && colon.index > 0) {
    return { path: raw.slice(0, colon.index), line: positive(colon[1]), column: positive(colon[2]) }
  }
  return { path: raw, line: null, column: null }
}

function decoded(raw: string): string {
  if (!/%[0-9A-Fa-f]{2}/u.test(raw)) return raw
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/* file:///C:/x → C:/x；file:///home/x → /home/x；file://server/share → //server/share。 */
function fromFileUrl(raw: string): string {
  const rest = raw.slice('file:'.length)
  const path = decoded(rest.startsWith('///') ? rest.slice(2) : rest)
  return /^\/[A-Za-z]:[\\/]/u.test(path) ? path.slice(1) : path
}

export function isAbsoluteFilePath(path: string): boolean {
  return DRIVE.test(path) || UNC.test(path) || path.startsWith('/')
}

/** 链接目标（作者写下的原文）→ 文件引用；网页、邮件、页内锚点之类返回 null。 */
export function fileRefOfTarget(target: string): FileRef | null {
  let raw = target.trim()
  if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1).trim()
  if (raw === '' || raw.startsWith('#') || raw.startsWith('?') || raw.startsWith('//')) return null
  if (!DRIVE.test(raw) && SCHEME.test(raw)) {
    if (!raw.toLowerCase().startsWith('file:')) return null
    raw = fromFileUrl(raw)
  } else {
    raw = decoded(raw)
  }
  if (raw.includes('\n')) return null
  const ref = withLine(raw)
  return ref.path === '' ? null : ref
}

function lastSegment(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/* 裸名字（不带目录）：图标认得出来，且不是 console.log 这类成员访问。 */
function bareNameLooksLikeFile(name: string): boolean {
  if (!/^[\w.@+-]+$/u.test(name) || knownFileMarkOf(name) === undefined) return false
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return true
  return !AMBIGUOUS_SUFFIX.has(name.slice(dot + 1).toLowerCase())
}

/**
 * 行内代码是不是一个文件引用。比链接保守得多：链接是作者明说「这是个去处」，行内代码可能是任何东西。
 * 认的是：带目录且最后一段图标认得出来（`src/a.ts`、`C:\x\b.md:12`），或裸文件名图标认得出来且不像成员访问。
 */
export function fileRefOfCode(code: string): FileRef | null {
  const raw = code.trim()
  if (raw === '' || raw.length > 300 || NOT_PATH.test(raw) || (SCHEME.test(raw) && !DRIVE.test(raw))) return null
  const ref = withLine(raw)
  const absolute = isAbsoluteFilePath(ref.path)
  if (/\s/u.test(ref.path) && !absolute) return null
  const name = lastSegment(ref.path)
  if (name === '' || name === '.' || name === '..') return null
  const nested = name !== ref.path
  if (nested) return knownFileMarkOf(name) === undefined ? null : ref
  return bareNameLooksLikeFile(name) ? ref : null
}

/** 改写成 `poietica-file:` 地址。`code` 记下它原本是行内代码：没有宿主可开时要原样画回代码，而不是变成一枚链接。 */
export function fileHrefOf(ref: FileRef, origin: 'link' | 'code'): string {
  const query = new URLSearchParams()
  if (ref.line !== null) query.set('line', String(ref.line))
  if (ref.column !== null) query.set('column', String(ref.column))
  if (origin === 'code') query.set('from', 'code')
  const tail = query.toString()
  return `${FILE_HREF_PREFIX}${encodeURIComponent(ref.path)}${tail === '' ? '' : `?${tail}`}`
}

export function fileRefOfHref(href: string): { readonly ref: FileRef; readonly origin: 'link' | 'code' } | null {
  if (!href.startsWith(FILE_HREF_PREFIX)) return null
  const body = href.slice(FILE_HREF_PREFIX.length)
  const at = body.indexOf('?')
  const encoded = at < 0 ? body : body.slice(0, at)
  const query = new URLSearchParams(at < 0 ? '' : body.slice(at + 1))
  let path: string
  try {
    path = decodeURIComponent(encoded)
  } catch {
    return null
  }
  if (path === '') return null
  return {
    ref: { path, line: positive(query.get('line') ?? undefined), column: positive(query.get('column') ?? undefined) },
    origin: query.get('from') === 'code' ? 'code' : 'link',
  }
}

export function fileNameOf(path: string): string {
  const name = lastSegment(path.replace(/[\\/]+$/u, ''))
  return name === '' ? path : name
}
