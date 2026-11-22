import { pathKey } from '@poietica/platform-kit'
import type { PythonStatus } from '../contract'
import { compareVersions, type PythonCandidate } from './detect'
import { MIN_PYTHON_VERSION } from './release'

export function statusOf(
  state: PythonStatus['state'],
  options: {
    readonly progress?: number | null
    readonly version?: string | null
    readonly interpreter?: string | null
    readonly error?: { readonly code: string; readonly message: string } | null
  } = {},
): PythonStatus {
  return {
    state,
    progress: options.progress ?? null,
    version: options.version ?? null,
    interpreter: options.interpreter ?? null,
    error: options.error ?? null,
  }
}

export function isSupported(version: string): boolean {
  return compareVersions(version, MIN_PYTHON_VERSION) >= 0
}

/**
 * 已经配置好、且版本达标的那一个优先（用户手动指到 venv 时不该被系统里的新版本顶掉）；否则取探测结果里的第一顺位。
 * `preferDetected` 只给「刚刚装完」用：这时用户要的就是新装的那一个。
 */
export function chooseCandidate(args: {
  readonly candidates: readonly PythonCandidate[]
  readonly current: string | null
  readonly preferDetected: boolean
}): PythonCandidate | null {
  if (args.preferDetected) return args.candidates[0] ?? null

  if (args.current !== null) {
    const key = pathKey(args.current)
    const current = args.candidates.find((candidate) => pathKey(candidate.path) === key)
    if (current !== undefined && isSupported(current.version)) return current
  }

  return args.candidates[0] ?? null
}
