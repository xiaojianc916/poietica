import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { type DataLayout, isolatedConfigDir } from '@poietica/runtime-layout'

export interface IsolationResult {
  /** 原来有值、且被我们改正的键（只有键名。serve.ts 在非空时记一条 warn：有人绕过 Host 手工启动了 exe） */
  readonly corrected: readonly string[]
  /** 被删除的键（只有键名） */
  readonly removed: readonly string[]
}

/** 隔离变量的键名。launch-env 的 scrubInjected 靠它保证这几个键不被误当成 .env 注入删掉。 */
export const ISOLATION_ENV_KEYS: readonly string[] = Object.freeze([
  'PI_CONFIG_DIR',
  'PI_CODING_AGENT_DIR',
  'XDG_DATA_HOME',
  'PI_NO_TITLE',
  'PI_NOTIFICATIONS',
  'PI_NO_PTY',
])

/** 隔离变量与期望值（04 页 §3.3 / 12 页 §4.5）。natives 加载器只认 XDG_DATA_HOME（omp 知识 #5） */
export function isolationEnv(layout: DataLayout, home = homedir()): Record<string, string> {
  return {
    PI_CONFIG_DIR: isolatedConfigDir(home, layout.ompRoot), // omp 知识 #5
    PI_CODING_AGENT_DIR: layout.ompAgentDir,
    XDG_DATA_HOME: layout.nativeHomeDir,
    PI_NO_TITLE: '1', // omp 知识 #4
    PI_NOTIFICATIONS: 'off',
    PI_NO_PTY: '1',
  }
}

const DROP = ['OMP_PROFILE', 'PI_PROFILE']

/**
 * 把隔离变量写进 process.env、删掉不该存在的变量、建好目录、把 cwd 换到一个空目录
 * （omp 去读 cwd/.env 时什么也读不到），返回被改正/删除的键名。
 */
export function prepareIsolation(
  layout: DataLayout,
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): IsolationResult {
  const corrected: string[] = []
  const removed: string[] = []
  for (const [key, value] of Object.entries(isolationEnv(layout, home))) {
    if (env[key] !== value) {
      if (env[key] !== undefined) corrected.push(key)
      env[key] = value
    }
  }
  for (const key of DROP) {
    if (env[key] !== undefined) {
      delete env[key]
      removed.push(key)
    }
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('XDG_') && key !== 'XDG_DATA_HOME') {
      delete env[key]
      removed.push(key)
    }
  }
  // natives 加载器只在 <XDG_DATA_HOME>/omp **已存在**时才认 XDG_DATA_HOME，否则回落到 ~/.omp：
  // 所以这两个目录必须在这里就建好，否则隔离在第一次 import pi-utils 时就被破坏
  // （pi-natives 的 native/loader-state.js:getNativesDir）。
  mkdirSync(path.join(layout.nativeHomeDir, 'omp', 'natives'), { recursive: true })
  mkdirSync(layout.coreCwd, { recursive: true })
  process.chdir(layout.coreCwd)
  return { corrected: Object.freeze(corrected), removed: Object.freeze(removed) }
}
