import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseRelayToken } from '@poietica/engine'
import type { DataLayout } from '@poietica/runtime-layout'

/*
 * browser relay 的 `/ext` 口令（线上契约见 @poietica/engine 的 browser-relay.ts）：
 * Core 生成、每个数据根一份放在 DataLayout.relayTokenFile，Host 连 /ext 时读同一个文件。
 * 进程环境里只放文件路径、不放口令本身 —— 环境会一路传给 agent 跑的 shell 命令，路径在 `env`
 * 输出里无害，口令出现在对话记录里就泄露了。按数据根持久化、不轮换：broker 可能比这一代 Core
 * 活得久（环境停在被拉起那一刻），持久化后旧环境拉起的 relay 读到的也是同一份口令。
 */

/** relay 进程从这个环境变量找口令文件。只在 Core 自己的进程里设置与读取，不属于 Host 与 Core 的启动契约 */
export const RELAY_TOKEN_FILE_ENV = 'POIETICA_RELAY_TOKEN_FILE'

/**
 * 确保数据根下有一份口令、并把文件路径放进本进程环境（之后派生的 broker / relay 继承它）。
 * 必须在 `scrubInjected()` 之后调用：它删的是「启动快照之后新出现的键」，先设就会被当成 .env 注入删掉。
 */
export function prepareRelayToken(
  layout: Pick<DataLayout, 'relayTokenFile'>,
  env: Record<string, string | undefined> = process.env,
): void {
  ensureRelayToken(layout.relayTokenFile)
  env[RELAY_TOKEN_FILE_ENV] = layout.relayTokenFile
}

/**
 * 确保口令文件在并返回口令。已有且格式正确就复用；缺失或被改坏时重建。先写临时文件再改名，relay 进程不会读到半个口令。
 * POSIX 上权限 0600；Windows 上文件继承用户目录的 ACL。
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

/**
 * browser-relay 子命令的参数补上 Core 生成的 `/ext` 口令。参数里已有 `--token`（手工运行）原样返回；
 * 环境里没有口令文件路径（不是 Core 派生的）保持 omp 默认行为；有路径但读不到或格式不对则抛错
 * —— 宁可浏览器工具报「relay 起不来」，也不把 `/ext` 敞开给本机任何进程。
 */
export function withRelayToken(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  readFile: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): readonly string[] {
  if (args.some((arg) => arg === '--token' || arg.startsWith('--token='))) return args
  const file = env[RELAY_TOKEN_FILE_ENV]
  if (file === undefined || file === '') return args
  let text: string
  try {
    text = readFile(file)
  } catch (cause) {
    throw new Error(`读不到 relay 口令文件 ${file}：${String(cause)}`)
  }
  const token = parseRelayToken(text)
  if (token === null) throw new Error(`relay 口令文件格式不对：${file}`)
  return [...args, '--token', token]
}
