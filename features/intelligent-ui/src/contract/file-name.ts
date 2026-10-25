const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i
const FORBIDDEN = '\\/:*?"<>|'

/*
 * 文件系统不认的字符（含控制字符）换成空格；文件名里的双向文本控制符（U+202A-U+202E、U+2066-U+2069）也去掉 ——
 * 它们会让资源管理器/终端把扩展名显示成反的，是钓鱼面；孤立代理项（Array.from 拆出来的单个代理项）一并换掉。
 */
function safeChar(char: string): string {
  const code = char.charCodeAt(0)
  const bidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
  /* Array.from 按码点拆：合法的代理对是 length=2 的一个字符串，只有落单的代理项才 length=1 */
  const loneSurrogate = char.length === 1 && code >= 0xd800 && code <= 0xdfff
  return code < 0x20 || code === 0x7f || bidi || loneSurrogate || FORBIDDEN.includes(char) ? ' ' : char
}

/** 保存对话框的默认文件名：标题去掉文件系统不认的字符；Windows 的保留名前面垫一个下划线 */
export function exportFileNameOf(title: string): string {
  const cleaned = Array.from(title, safeChar)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim()
  const base = cleaned === '' ? '界面' : RESERVED.test(cleaned) ? `_${cleaned}` : cleaned
  return `${base}.html`
}
