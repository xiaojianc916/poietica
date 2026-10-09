import type { LogLevel } from '@poietica/foundation' // LogLevel 的唯一定义在 foundation 的 logger.ts（11 页 P1.1）

export interface CoreArgs {
  readonly mode: 'serve'
  readonly dataRoot: string
  readonly logLevel: LogLevel
  readonly relayPort: number
  readonly strict: boolean
  /** 只有探针版（编译时注入 POIETICA_PROBE_BUILD="1"）接受 --probe-mock-model；正式版遇到它按未知参数报错 */
  readonly probeMockModel: boolean
}
export class CoreArgsError extends Error {
  override readonly name = 'CoreArgsError'
}

const LEVELS: ReadonlySet<string> = new Set(['debug', 'info', 'warn', 'error'])

/** 解析 `poietica-core.exe serve --data-root <p> --log-level <l> --relay-port <n> [--strict] [--probe-mock-model]`。任何问题都抛 CoreArgsError（serve.ts 捕获后以退出码 2 退出） */
export function parseCoreArgs(
  argv: readonly string[],
  opts: { readonly probeBuild: boolean } = { probeBuild: process.env.POIETICA_PROBE_BUILD === '1' },
): CoreArgs {
  const [, , mode, ...rest] = argv
  if (mode !== 'serve') throw new CoreArgsError(`未知模式：${String(mode)}`)
  const values = new Map<string, string>()
  let strict = false
  let probeMockModel = false
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!
    if (key === '--strict') {
      strict = true
      continue
    }
    if (key === '--probe-mock-model' && opts.probeBuild) {
      probeMockModel = true
      continue
    }
    if (key !== '--data-root' && key !== '--log-level' && key !== '--relay-port')
      throw new CoreArgsError(`未知参数：${key}`)
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) throw new CoreArgsError(`参数缺少值：${key}`)
    if (values.has(key)) throw new CoreArgsError(`参数重复：${key}`)
    values.set(key, value)
    i++
  }
  const dataRoot = values.get('--data-root')
  const logLevel = values.get('--log-level')
  const relayPortText = values.get('--relay-port')
  if (dataRoot === undefined) throw new CoreArgsError('缺少 --data-root')
  if (logLevel === undefined || !LEVELS.has(logLevel)) throw new CoreArgsError('缺少或无效的 --log-level')
  const relayPort = Number(relayPortText)
  if (relayPortText === undefined || !Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535)
    throw new CoreArgsError('缺少或无效的 --relay-port')
  return { mode: 'serve', dataRoot, logLevel: logLevel as LogLevel, relayPort, strict, probeMockModel }
}
