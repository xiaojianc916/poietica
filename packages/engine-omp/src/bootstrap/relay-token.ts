import { readFileSync } from 'node:fs'
import { parseRelayToken, RELAY_TOKEN_FILE_ENV } from '@poietica/runtime-layout'

/**
 * browser-relay 子命令的参数补上 Host 生成的 `/ext` 口令（契约见 runtime-layout 的 relay-token.ts）。
 *
 * - 参数里已有 `--token`：手工运行的意思优先，原样返回；
 * - 环境里没有口令文件路径：不是 Host 拉起的 Core 派生出来的（例如开发者手工跑 `poietica-core browser-relay`），
 *   保持 omp 的默认行为；
 * - 有路径但读不到或格式不对：抛错，由调用方拒绝启动 —— 宁可浏览器工具报「relay 起不来」，也不在没有口令的情况下
 *   把 `/ext` 敞开给本机任何进程。
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
