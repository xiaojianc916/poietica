import path from 'node:path'
import type { InstallMarker, PythonStatus } from '../contract'
import { PYTHON_ASSET_SHA256, PYTHON_RELEASE_TAG, PYTHON_VERSION } from './release'

export function statusOf(
  state: 'absent' | 'downloading' | 'installing' | 'ready' | 'failed',
  progress: number | null = null,
  error: { code: string; message: string } | null = null,
  interpreter: string | null = null,
): PythonStatus {
  return {
    state,
    progress,
    version: state === 'ready' ? PYTHON_VERSION : null,
    interpreter,
    error,
  }
}

export function markerMatches(marker: InstallMarker | null): boolean {
  if (marker === null) return false
  return marker.tag === PYTHON_RELEASE_TAG && marker.version === PYTHON_VERSION && marker.sha256 === PYTHON_ASSET_SHA256
}

/** 该解释器路径是不是落在我们管的目录里（不区分大小写，Windows 语义）。 */
export function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * `onReady` 的判据（07 页 §13C 的 onReady 一行）：标记与 exe 都对 → ready，并把解释器
 * 再写给 omp 一次（保证设置与实际一致）；否则 absent，且**当且仅当** omp 当前解释器
 * 指向我们的目录内部时把它清空（指向别处的设置不是我们该动的）。
 */
export function onReadyPlan(args: {
  readonly marker: unknown
  readonly exeExists: boolean
  readonly interpreter: string | null
  readonly pythonDir: string
}): { readonly ready: boolean; readonly exePath: string | null; readonly clearInterpreter: boolean } {
  const marker = args.marker === null || typeof args.marker !== 'object' ? null : (args.marker as InstallMarker)
  if (markerMatches(marker) && args.exeExists) {
    return { ready: true, exePath: path.join(args.pythonDir, 'python.exe'), clearInterpreter: false }
  }
  return {
    ready: false,
    exePath: null,
    clearInterpreter: args.interpreter !== null && isInside(args.pythonDir, args.interpreter),
  }
}
