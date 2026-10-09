import path from 'node:path'
import { isInside } from '@poietica/fs-kit'
import type { DataLayout } from '@poietica/runtime-layout'

export interface IsolationSelfCheck {
  readonly ok: boolean
  /** 越界的目录（键为用途名，值为绝对路径） */
  readonly violations: readonly string[]
  /** 全部实际解析出来的目录，供 platform.diagnostics 展示 */
  readonly dirs: Readonly<Record<string, string>>
}

/**
 * 启动自检：omp 的每个目录都必须落在隔离根之内，否则以退出码 3 退出（12 页 §4.6）。
 * natives 加载器自己算目录、不走 dirs 模块，所以额外核对一个（04 页 §3.3 第 4 条）。
 */
export async function runIsolationSelfCheck(layout: DataLayout): Promise<IsolationSelfCheck> {
  const dirs = await import('@oh-my-pi/pi-utils/dirs')
  const resolved: Record<string, string> = {
    config: dirs.getConfigRootDir(),
    agent: dirs.getAgentDir(),
    sessions: dirs.getSessionsDir(),
    plugins: dirs.getPluginsDir(),
    logs: dirs.getLogsDir(),
    python: dirs.getPythonEnvDir(),
    browserRelay: dirs.getBrowserRelayDir(),
    worktrees: dirs.getWorktreesDir(),
    natives: dirs.getNativesDir(),
  }
  const violations: string[] = []
  for (const [name, dir] of Object.entries(resolved)) {
    // orEqual: omp 的「配置根」就是 ompRoot 本身，等于也算落在隔离根之内
    if (!isInside(layout.ompRoot, dir, { orEqual: true })) violations.push(`${name}=${dir}`)
  }
  // natives 加载器的候选目录：<XDG_DATA_HOME>/omp/natives（在隔离根之内才行）
  const nativeLoaderDir = path.join(layout.nativeHomeDir, 'omp', 'natives')
  resolved.nativeLoader = nativeLoaderDir
  if (!isInside(layout.root, nativeLoaderDir, { orEqual: true })) violations.push(`nativeLoader=${nativeLoaderDir}`)
  return { ok: violations.length === 0, violations: Object.freeze(violations), dirs: Object.freeze(resolved) }
}
