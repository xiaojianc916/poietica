import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseRelayToken } from '@poietica/runtime-layout'

/**
 * 确保数据根下有一份 browser relay `/ext` 口令并返回它（契约见 runtime-layout 的 relay-token.ts）。
 *
 * 已有且格式正确就复用 —— 口令按数据根持久化，不随每次启动轮换；缺失或被改坏时重建。先写临时文件再改名，
 * relay 进程不会读到半个口令。POSIX 上权限 0600；Windows 上文件继承用户目录的 ACL。
 * 同步实现：几十字节、每次拉起 Core 只调一次，换来 launch() 里少一处让出时机（代际检查都在同步段里）。
 */
export function ensureRelayToken(file: string): string {
  const existing = readExisting(file)
  if (existing !== null) return existing
  const token = randomBytes(32).toString('hex')
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, token, { mode: 0o600 })
  renameSync(tmp, file)
  return token
}

function readExisting(file: string): string | null {
  try {
    return parseRelayToken(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
