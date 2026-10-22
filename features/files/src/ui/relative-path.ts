/* Markdown 预览里的相对链接相对的是那份文件所在的目录：先在这里拼成工作区内的相对路径，再交给打开入口。 */

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
