// 每个会 import omp 的测试文件，第一行都必须是 import './omp-home'（路径按实际层级调整）。
// ESM 按书写顺序求值依赖，第一行的 import 会先于后面所有 import 执行。
//
// 为什么必须这样做：omp 的目录由 @oh-my-pi/pi-utils/dirs 在**模块求值时**读取环境变量算出，
// 而且整个进程只算一次；bun test 默认把所有测试文件放在同一个进程里（12 页 §2.2）。
import { mkdirSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { isInside } from '@poietica/fs-kit'
import { type DataLayout, dataLayout, isolatedConfigDir } from '@poietica/runtime-layout'

interface TestOmpHome {
  readonly layout: DataLayout
  readonly envKeys: readonly string[]
}

declare global {
  var __poieticaOmpHome: TestOmpHome | undefined
}

const ISOLATION_KEYS = [
  'PI_CONFIG_DIR',
  'PI_CODING_AGENT_DIR',
  'XDG_DATA_HOME',
  'PI_NO_TITLE',
  'PI_NOTIFICATIONS',
  'PI_NO_PTY',
] as const

function setup(): TestOmpHome {
  // isolatedConfigDir 要求数据根位于用户目录之下；Windows 的 %TEMP% 满足这个条件。
  // 但两边必须先归一到同一命名口径：CI runner 上 tmpdir() 是 8.3 短名（C:\Users\RUNNER~1\…）、
  // homedir() 是长名（C:\Users\runneradmin），直接比字符串会把「就在用户目录之下」误判成越界。
  const root = path.join(realpathSync.native(tmpdir()), `poietica-omp-home-${process.pid}-${Date.now()}`)
  const home = realpathSync.native(homedir())
  if (!isInside(home, root)) {
    throw new Error(`测试临时目录必须位于用户目录之下：${root}（用户目录 ${home}）`)
  }
  const layout = dataLayout(root)
  const env: Record<string, string> = {
    PI_CONFIG_DIR: isolatedConfigDir(home, layout.ompRoot),
    PI_CODING_AGENT_DIR: layout.ompAgentDir,
    XDG_DATA_HOME: layout.nativeHomeDir,
    PI_NO_TITLE: '1',
    PI_NOTIFICATIONS: 'off',
    PI_NO_PTY: '1',
  }
  for (const key of ISOLATION_KEYS) process.env[key] = env[key]
  for (const dir of Object.values(layout)) {
    if (typeof dir === 'string' && dir.startsWith(root)) mkdirSync(dir, { recursive: true })
  }
  return { layout, envKeys: ISOLATION_KEYS }
}

const existing = globalThis.__poieticaOmpHome
const state = existing ?? setup()
globalThis.__poieticaOmpHome = state

export const testLayout: DataLayout = state.layout
export const testIsolationKeys: readonly string[] = state.envKeys
