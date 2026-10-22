/*
 * 「用默认应用打开」不放行可执行的类型。
 *
 * shell.openPath 交给系统按扩展名处理：.exe 会被运行、.bat / .ps1 / .vbs / .js 在 Windows 上默认也是执行。树里点一下、
 * 或者模型写下的一个路径，都不该变成「运行了一个程序」—— 这些类型只给「在资源管理器中显示」，打不打开由人在那边决定。
 */
const EXECUTABLE = new Set([
  'app',
  'appref-ms',
  'bat',
  'cmd',
  'com',
  'command',
  'cpl',
  'exe',
  'hta',
  'jar',
  'js',
  'jse',
  'lnk',
  'msc',
  'msi',
  'msp',
  'ps1',
  'psm1',
  'reg',
  'scr',
  'sh',
  'url',
  'vbe',
  'vbs',
  'ws',
  'wsf',
  'wsh',
])

export function opensAsProgram(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 && EXECUTABLE.has(name.slice(dot + 1).toLowerCase())
}

export function parentDirectory(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}

/** 相对路径按某个目录拼起来（Markdown 里的相对链接相对的是那份文件所在的目录）。`..` 由 Core 的边界校验兜底。 */
export function joinPath(dir: string, relative: string): string {
  const parts = dir === '' ? [] : dir.split('/')
  for (const part of relative.replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}
