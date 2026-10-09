const MAX_TITLE_CHARS = 60
export const PENDING_TITLE = '新对话'

/** 取首条消息：所有空白折叠为一个空格、去掉首尾空白，按 Unicode 字符（不是 UTF-16 码元）截断到 60 个，超出加“…” */
export function deriveTitle(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat === '') return PENDING_TITLE
  const chars = Array.from(flat)
  return chars.length <= MAX_TITLE_CHARS ? flat : `${chars.slice(0, MAX_TITLE_CHARS).join('')}…`
}

/** threads.rename 的规则：去首尾空白后截断到 120 个字符（07 页 §5C 服务行为表） */
export function normalizeTitle(title: string): string {
  return Array.from(title.trim()).slice(0, 120).join('')
}
