import path from 'node:path'

const norm = (p: string): string => path.resolve(p).toLowerCase()

/** Windows 路径比较：解析为绝对路径后不区分大小写 */
export function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b)
}

/**
 * child 是否位于 parent 之内。orEqual=false（默认）时 child 等于 parent 返回 false。
 * 只做字符串层面的判断，不解析符号链接与 junction。
 */
export function isInside(parent: string, child: string, o: { orEqual?: boolean } = {}): boolean {
  const rel = path.relative(norm(parent), norm(child))
  if (rel === '') return o.orEqual === true
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}
