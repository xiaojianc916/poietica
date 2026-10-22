import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '@poietica/foundation'
import { isInside } from '@poietica/fs-kit'
import { filesErrors } from '../contract/errors'

/*
 * 工作区的路径边界只有这一处。两道关：
 * 1. 字面：相对路径按根解析、绝对路径照收，解析完必须落在根之内（挡 `../`、挡别的盘）；
 * 2. 真实：符号链接 / junction 解开之后仍须在根之内 —— 只做字面判断的话，工作区里一条指向 C:\Windows 的链接就能把它读出来。
 * 相对路径统一成正斜杠：界面拿它当身份，Windows 与 POSIX 必须是同一个字符串。
 */

export interface ResolvedPath {
  /** 字面解析后的绝对路径（人看得懂的那一个：「在资源管理器中显示」用它）。 */
  readonly absolute: string
  /** 相对工作区根、正斜杠；根本身是 ''。 */
  readonly relative: string
}

export interface RealPath extends ResolvedPath {
  /** 解开链接之后的真实路径：读字节用它。 */
  readonly real: string
}

export function toRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/')
}

function outside(input: string): AppError {
  return new AppError(filesErrors.outside_workspace, `不在工作区内：${input}`, { path: input })
}

export function resolveLexical(root: string, input: string): ResolvedPath {
  const trimmed = input.trim()
  const absolute = path.resolve(root, trimmed === '' ? '.' : trimmed)
  if (!isInside(root, absolute, { orEqual: true })) {
    throw outside(input)
  }
  return { absolute, relative: toRelative(root, absolute) }
}

/** 文件系统错误 → 契约错误码；认不出的原样抛（落成 internal，日志里看得到原因）。 */
export function fsFailure(cause: unknown, input: string): unknown {
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : ''
  if (code === 'ENOENT') return new AppError(filesErrors.not_found, `文件不存在：${input}`, { path: input })
  if (code === 'ENOTDIR') return new AppError(filesErrors.not_a_directory, `不是目录：${input}`, { path: input })
  if (code === 'EISDIR') return new AppError(filesErrors.is_directory, `是目录：${input}`, { path: input })
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
    return new AppError(filesErrors.unreadable, `无法读取：${input}`, { path: input, cause: code })
  }
  return cause
}

export async function resolveReal(root: string, input: string): Promise<RealPath> {
  const lexical = resolveLexical(root, input)
  const [realRoot, real] = await Promise.all([
    realpath(root),
    realpath(lexical.absolute).catch((cause: unknown) => {
      throw fsFailure(cause, input)
    }),
  ])
  if (!isInside(realRoot, real, { orEqual: true })) {
    throw outside(input)
  }
  return { ...lexical, real }
}
