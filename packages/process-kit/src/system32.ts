import path from 'node:path'

/** 系统目录里的固定路径：不走 PATH（PATH 是用户环境，安装器与卸载场景不可信） */
export function system32(exe: string): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', exe)
}
