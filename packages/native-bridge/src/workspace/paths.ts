import { hostBridge } from '../host-bridge'

/*
 * 平台路径事实的唯一出口。渲染层没有 fs 也没有 path，所以主目录问宿主，
 * 文件名自己按分隔符切 —— 切最后一段不需要平台知识。
 */

/** 用户主目录。无项目工作区没有指定根时退到它。 */
export function homeDirectory(): Promise<string> {
  return hostBridge().host.homeDirectory()
}

/** 路径最后一段。输入里没有分隔符时就是它自己。 */
export function basename(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))

  return separator === -1 ? path : path.slice(separator + 1)
}
