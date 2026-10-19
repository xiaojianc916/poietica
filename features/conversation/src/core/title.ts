const MAX_DERIVED_CHARS = 60
const MAX_STORED_CHARS = 120
export const PENDING_TITLE = '新对话'

/** 取首条消息：所有空白折叠为一个空格、去掉首尾空白，按 Unicode 字符（不是 UTF-16 码元）截断到 60 个，超出加“…” */
export function deriveTitle(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat === '') return PENDING_TITLE
  const chars = Array.from(flat)
  return chars.length <= MAX_DERIVED_CHARS ? flat : `${chars.slice(0, MAX_DERIVED_CHARS).join('')}…`
}

/** threads.rename 的规则：去首尾空白后截断到 120 个字符（07 页 §5C 服务行为表） */
export function normalizeTitle(title: string): string {
  return Array.from(title.trim()).slice(0, MAX_STORED_CHARS).join('')
}

/* 结尾的分叉后缀串：（分支）、（分支）（分支）、（分支2）… 只认贴着名字末尾的那一串。 */
const FORK_SUFFIX_RUN = /(?:（分支(?:\d+)?）)+/gu

/** 串里每一段「（分支n）」的序号；没有号码的一段算第 1 档。 */
const FORK_MARKER = /（分支(?:(\d+))?）/gu

/**
 * 分叉出的对话叫什么：源名加下一个分叉序号 —— 第一次是「（分支）」，再分叉就是
 * 「（分支2）」，不是「（分支）（分支）」。旧版本已经叠出来的那两段在这里一并收拢。
 *
 * 上限按整串算、后缀从尾部保留：正文先截，序号永远在（「很长…（分支2）」）。
 */
export function forkTitleOf(source: string): string {
  const trimmed = source.trim()
  const runs = [...trimmed.matchAll(FORK_SUFFIX_RUN)]
  const tail = runs.at(-1)
  const attached = tail !== undefined && (tail.index ?? 0) + tail[0].length === trimmed.length ? tail : undefined
  let level = 0
  if (attached !== undefined) {
    for (const marker of attached[0].matchAll(FORK_MARKER)) {
      level = Math.max(level, marker[1] === undefined ? 1 : Number(marker[1]))
    }
  }
  const next = level + 1
  const suffix = next === 1 ? '（分支）' : `（分支${String(next)}）`
  const named = attached === undefined ? trimmed : trimmed.slice(0, attached.index).trimEnd()
  const base = named === '' && attached === undefined ? PENDING_TITLE : named
  const room = MAX_STORED_CHARS - Array.from(suffix).length
  return Array.from(base).slice(0, room).join('') + suffix
}
