import { describe, expect, test } from 'bun:test'
import { AppError } from '@poietica/foundation'
import { buildCoreLaunch, CORE_EXIT_CODES, CORE_SHUTDOWN_BUDGET_MS, isolatedConfigDir } from '../core-launch'

const HOME = 'C:\\Users\\a'
const DATA_ROOT = 'C:\\Users\\a\\AppData\\Roaming\\Poietica Dev'

const INPUT = {
  coreExe: 'C:\\Program Files\\Poietica\\resources\\core\\poietica-core.exe',
  dataRoot: DATA_ROOT,
  homeDir: HOME,
  relayPort: 4321,
  logLevel: 'info' as const,
  strict: true,
  baseEnv: {
    PATH: 'C:\\Windows\\System32',
    OPENAI_API_KEY: 'sk-secret',
    AWS_ACCESS_KEY_ID: 'AKIA',
    GITHUB_TOKEN: 'ghp_x',
    MY_AUTH_TOKEN: 'tok',
    SOME_SECRET_KEY: 'sec',
    PI_CONFIG_DIR: 'C:\\Users\\a\\.pi',
    XDG_DATA_HOME: 'C:\\Users\\a\\.local\\share',
    POIETICA_DATA_ROOT: 'C:\\poietica',
    GIT_DIR: 'C:\\repo\\.git',
    NODE_OPTIONS: '--max-old-space-size=4096',
    UNDEFINED_VALUE: undefined,
    MY_VAR: 'kept',
  },
}

describe('buildCoreLaunch', () => {
  // RL-5：凭据变量被删除、PI_CONFIG_DIR 是相对 home 的路径、mustExistDirs 含 native-home\\omp
  test('RL-5 凭据与隔离前缀变量被删除，其它变量保留', () => {
    const launch = buildCoreLaunch(INPUT)
    expect(launch.env.PATH).toBe('C:\\Windows\\System32')
    expect(launch.env.MY_VAR).toBe('kept')
    for (const key of [
      'OPENAI_API_KEY',
      'AWS_ACCESS_KEY_ID',
      'GITHUB_TOKEN',
      'MY_AUTH_TOKEN',
      'SOME_SECRET_KEY',
      'POIETICA_DATA_ROOT',
      'GIT_DIR',
      'NODE_OPTIONS',
      'UNDEFINED_VALUE',
    ]) {
      expect(launch.env[key]).toBeUndefined()
    }
    // PI_CONFIG_DIR / XDG_DATA_HOME 被隔离值覆盖（不是继承来的原值）
    expect(launch.env.PI_CONFIG_DIR).not.toBe('C:\\Users\\a\\.pi')
    expect(launch.env.XDG_DATA_HOME).not.toBe('C:\\Users\\a\\.local\\share')
  })

  test('RL-5 PI_CONFIG_DIR 是相对 home 的路径', () => {
    const launch = buildCoreLaunch(INPUT)
    expect(launch.env.PI_CONFIG_DIR).toBe('AppData\\Roaming\\Poietica Dev\\omp')
    expect(isolatedConfigDir(HOME, `${DATA_ROOT}\\omp`)).toBe('AppData\\Roaming\\Poietica Dev\\omp')
  })

  test('RL-5 隔离变量与启动参数', () => {
    const launch = buildCoreLaunch(INPUT)
    expect(launch.command).toBe(INPUT.coreExe)
    expect(launch.args).toEqual([
      'serve',
      '--data-root',
      DATA_ROOT,
      '--log-level',
      'info',
      '--relay-port',
      '4321',
      '--strict',
    ])
    expect(launch.cwd).toBe(`${DATA_ROOT}\\core\\cwd`)
    expect(launch.env.PI_CODING_AGENT_DIR).toBe(`${DATA_ROOT}\\omp\\agent`)
    expect(launch.env.XDG_DATA_HOME).toBe(`${DATA_ROOT}\\native-home`)
    expect(launch.env.PI_NO_TITLE).toBe('1')
    expect(launch.env.PI_NOTIFICATIONS).toBe('off')
    expect(launch.env.PI_NO_PTY).toBe('1')
  })

  test('RL-5 mustExistDirs 含 native-home\\omp', () => {
    const launch = buildCoreLaunch(INPUT)
    expect(launch.mustExistDirs).toEqual([
      `${DATA_ROOT}\\core`,
      `${DATA_ROOT}\\core\\cwd`,
      `${DATA_ROOT}\\omp\\agent`,
      `${DATA_ROOT}\\native-home\\omp`,
      `${DATA_ROOT}\\logs`,
    ])
  })

  test('RL-5 非 strict 时不带 --strict', () => {
    expect(buildCoreLaunch({ ...INPUT, strict: false }).args).toEqual([
      'serve',
      '--data-root',
      DATA_ROOT,
      '--log-level',
      'info',
      '--relay-port',
      '4321',
    ])
  })

  test('RL-5 数据根不在 home 之下 → kernel.data_root_invalid', () => {
    const error = (() => {
      try {
        buildCoreLaunch({ ...INPUT, dataRoot: 'D:\\Poietica' })
        return null
      } catch (e) {
        return e
      }
    })()
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('kernel.data_root_invalid')
  })

  test('RL-5 CORE_EXIT_CODES', () => {
    expect(CORE_EXIT_CODES).toEqual({ ok: 0, crashed: 1, badArguments: 2, isolationViolated: 3 })
  })

  /* R-05 §3.3：Host 与 Core 共用这一份预算，Host 的宽限期必须比它长（+2 秒） */
  test('R-05 CORE_SHUTDOWN_BUDGET_MS 是 8 秒', () => {
    expect(CORE_SHUTDOWN_BUDGET_MS).toBe(8_000)
  })
})
