// packages/runtime-layout/src/core-launch.ts
import path from 'node:path'
import { AppError } from '@poietica/foundation'
import { dataLayout } from './data-layout'

const CREDENTIAL_PATTERNS = [/_API_KEY$/i, /_AUTH_TOKEN$/i, /_OAUTH_TOKEN$/i, /_ACCESS_TOKEN$/i, /_SECRET_KEY$/i]
const CREDENTIAL_NAMES = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
])
const DROP_PREFIXES = ['PI_', 'OMP_', 'XDG_', 'POIETICA_']
const DROP_NAMES = new Set([
  'PSMODULEPATH',
  'NODE_OPTIONS',
  'BUN_OPTIONS',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
])

/**
 * Core 退出码（06 页 §2.7）。后两个是**确定性失败**的专属码：Host 见到它们不再退避重启
 * （重试不会改变结果，只会把一句实话拖成五轮重启后的 `crash_loop`，R-08-8）。
 *
 * - `dataTooNew`：数据库版本高于本程序已知的迁移（降级安装），必须换回新版本才能读；
 * - `startFailed`：内核装配期就失败（模块图不合法、有方法没实现……），日志里已有具体原因。
 */
export const CORE_EXIT_CODES = {
  ok: 0,
  crashed: 1,
  badArguments: 2,
  isolationViolated: 3,
  dataTooNew: 4,
  startFailed: 5,
} as const

/**
 * Core 从收到 core.shutdown 到进程退出的总预算（R-05 §3.3）。
 *
 * Host 的宽限期必须大于它（core-supervisor 的 STOP_GRACE_MS 加 2 秒），否则 Core 自己的
 * 预算还没花完，Host 就先把进程树杀了 —— 那时可能还在逐条关会话、flush 设置，
 * 数据库也没来得及 close。
 */
export const CORE_SHUTDOWN_BUDGET_MS = 8_000

export interface CoreLaunchInput {
  readonly coreExe: string // <resources>/core/poietica-core.exe
  readonly dataRoot: string
  readonly homeDir: string // os.homedir()
  readonly relayPort: number
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  readonly strict: boolean // 开发版 true：Core 校验自己发出的结果与通知（06 页 §2.3）
  readonly baseEnv: Readonly<Record<string, string | undefined>>
}
export interface CoreLaunch {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly mustExistDirs: readonly string[] // Host 在 spawn 前 mkdir -p
}

export function isolatedConfigDir(homeDir: string, ompRoot: string): string {
  const rel = path.relative(homeDir, ompRoot)
  if (rel === '' || path.isAbsolute(rel) || rel.startsWith('..') || rel.includes(':')) {
    throw new AppError('kernel.data_root_invalid', `数据目录必须位于用户目录之下：${ompRoot}`)
  }
  return rel
}

export function buildCoreLaunch(input: CoreLaunchInput): CoreLaunch {
  const layout = dataLayout(input.dataRoot)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.baseEnv)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (DROP_PREFIXES.some((p) => upper.startsWith(p))) continue
    if (DROP_NAMES.has(upper) || CREDENTIAL_NAMES.has(upper)) continue
    if (CREDENTIAL_PATTERNS.some((r) => r.test(key))) continue
    env[key] = value
  }
  Object.assign(env, {
    PI_CONFIG_DIR: isolatedConfigDir(input.homeDir, layout.ompRoot),
    PI_CODING_AGENT_DIR: layout.ompAgentDir,
    XDG_DATA_HOME: layout.nativeHomeDir,
    PI_NO_TITLE: '1',
    PI_NOTIFICATIONS: 'off',
    PI_NO_PTY: '1',
  })
  return {
    command: input.coreExe,
    args: [
      'serve',
      '--data-root',
      layout.root,
      '--log-level',
      input.logLevel,
      '--relay-port',
      String(input.relayPort),
      ...(input.strict ? ['--strict'] : []),
    ],
    env,
    cwd: layout.coreCwd,
    mustExistDirs: [
      layout.coreDir,
      layout.coreCwd,
      layout.ompAgentDir,
      path.join(layout.nativeHomeDir, 'omp'),
      layout.logsDir,
    ],
  }
}
