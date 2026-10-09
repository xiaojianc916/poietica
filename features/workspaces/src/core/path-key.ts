import path from 'node:path'

/** Windows 路径不区分大小写：规范化后转小写作为唯一键；去掉末尾分隔符（盘符根目录除外） */
export function pathKey(p: string): string {
  let r = path.resolve(p)
  if (r.length > 3 && (r.endsWith('\\') || r.endsWith('/'))) r = r.slice(0, -1)
  return r.toLowerCase()
}
