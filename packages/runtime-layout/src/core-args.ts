import type { LogLevel } from '@poietica/foundation' // LogLevel 的唯一定义在 foundation 的 logger.ts（11 页 P1.1）

export interface CoreArgs {
  readonly mode: 'serve'
  readonly dataRoot: string
  readonly logLevel: LogLevel
  readonly strict: boolean
  /** 只有探针版（编译时注入 POIETICA_PROBE_BUILD="1"）接受 --probe-mock-model；正式版遇到它按未知参数报错 */
  readonly probeMockModel: boolean
}
export class CoreArgsError extends Error {
  override readonly name = 'CoreArgsError'
}

const LEVELS: ReadonlySet<string> = new Set(['debug', 'info', 'warn', 'error'])

/** 解析 `poietica-core.exe serve --data-root <p> --log-level <l> [--strict] [--probe-mock-model]`。任何问题都抛 CoreArgsError（serve.ts 捕获后以退出码 2 退出） */
interface Flags {
  strict: boolean
  probeMockModel: boolean
}

/** 只认白名单参数：--strict、--probe-mock-model（仅探针版）、--data-root <p>、--log-level <l> */
function readArgs(rest: readonly string[], values: Map<string, string>, probeBuild: boolean): Flags {
  const flags: Flags = { strict: false, probeMockModel: false }
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!
    if (key === '--strict') {
      flags.strict = true
      continue
    }
    if (key === '--probe-mock-model' && probeBuild) {
      flags.probeMockModel = true
      continue
    }
    if (key !== '--data-root' && key !== '--log-level') throw new CoreArgsError(`未知参数：${key}`)
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) throw new CoreArgsError(`参数缺少值：${key}`)
    if (values.has(key)) throw new CoreArgsError(`参数重复：${key}`)
    values.set(key, value)
    i++
  }
  return flags
}

export function parseCoreArgs(
  argv: readonly string[],
  opts: { readonly probeBuild: boolean } = { probeBuild: process.env.POIETICA_PROBE_BUILD === '1' },
): CoreArgs {
  const [, , mode, ...rest] = argv
  if (mode !== 'serve') throw new CoreArgsError(`未知模式：${String(mode)}`)
  const values = new Map<string, string>()
  let strict = false
  let probeMockModel = false
  const flags = readArgs(rest, values, opts.probeBuild)
  strict = flags.strict
  probeMockModel = flags.probeMockModel
  const dataRoot = values.get('--data-root')
  const logLevel = values.get('--log-level')
  if (dataRoot === undefined) throw new CoreArgsError('缺少 --data-root')
  if (logLevel === undefined || !LEVELS.has(logLevel)) throw new CoreArgsError('缺少或无效的 --log-level')
  return { mode: 'serve', dataRoot, logLevel: logLevel as LogLevel, strict, probeMockModel }
}
