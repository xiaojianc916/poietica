import { describe, expect, test } from 'bun:test'
import type { ProcessInfo } from '@poietica/process-kit'
import { createTestLogger } from '@poietica/test-kit'
import { findStaleCoreProcesses, reapStaleCoreProcesses } from '../core-reaper'

const CORE_EXE = String.raw`D:\WindowsApp\Poietica\resources\core\poietica-core.exe`
/** 别的 checkout / 别的安装目录的 Core：路径不同就是别人的，一概不碰 */
const OTHER_CORE_EXE = String.raw`D:\xiaojianc\poietica\apps\core\dist\poietica-core.exe`

function proc(partial: Partial<ProcessInfo> & { pid: number }): ProcessInfo {
  return {
    parentPid: 0,
    name: 'poietica-core.exe',
    executablePath: CORE_EXE,
    commandLine: '',
    ...partial,
  }
}

describe('findStaleCoreProcesses', () => {
  test('上一代 Core 与它的 omp 后台进程都在清单里，本代自己的 pid 跳过', () => {
    const rows = [
      proc({ pid: 100, commandLine: 'poietica-core.exe serve --data-root C:\\d --relay-port 1' }),
      // detached 的 omp daemon broker：命令行里是 __omp_worker_*，不在 Core 的进程树里
      proc({ pid: 200, commandLine: 'poietica-core.exe __omp_worker_daemon_broker' }),
      proc({ pid: 300 }),
    ]
    const stale = findStaleCoreProcesses(rows, 300, CORE_EXE)
    expect(stale.map((s) => [s.pid, s.what])).toEqual([
      [100, 'core'],
      [200, 'omp-worker'],
    ])
  })

  test('别的路径上的 Core 一律不动（同机还有 dev checkout 时不能互杀）', () => {
    const rows = [
      proc({ pid: 1, executablePath: OTHER_CORE_EXE, commandLine: 'poietica-core.exe serve --data-root C:\\d' }),
      proc({ pid: 2, executablePath: OTHER_CORE_EXE, commandLine: 'poietica-core.exe __omp_worker_daemon_broker' }),
      proc({ pid: 3, name: 'bun.exe', executablePath: 'C:\\bun\\bun.exe', commandLine: 'bun test __omp_worker_x' }),
    ]
    expect(findStaleCoreProcesses(rows, undefined, CORE_EXE)).toEqual([])
  })

  test('大小写与加长路径前缀不影响匹配', () => {
    const rows = [
      proc({
        pid: 4,
        executablePath: '\\\\?\\d:\\windowsapp\\poietica\\RESOURCES\\CORE\\Poietica-Core.exe',
      }),
    ]
    expect(findStaleCoreProcesses(rows, undefined, CORE_EXE).map((s) => s.pid)).toEqual([4])
  })

  test('命令行为空的同名进程也清（宁可多清一个后台进程，也别留下占着 exe 的那个）', () => {
    const rows = [proc({ pid: 7, name: 'poietica-core.exe', executablePath: '' })]
    expect(findStaleCoreProcesses(rows, undefined, CORE_EXE).map((s) => s.pid)).toEqual([7])
  })

  test('拿不到 ExecutablePath 时按名字兜底，但必须是 core.exe', () => {
    const rows = [
      proc({
        pid: 9,
        name: 'poietica-core.exe',
        executablePath: '',
        commandLine: 'poietica-core.exe __omp_worker_lsp_mux',
      }),
      proc({ pid: 10, name: 'notepad.exe', executablePath: '', commandLine: 'notepad __omp_worker_x' }),
    ]
    expect(findStaleCoreProcesses(rows, undefined, CORE_EXE).map((s) => s.what)).toEqual(['omp-worker'])
  })
})

describe('reapStaleCoreProcesses', () => {
  test('读进程表失败不抛错，只记 warn', async () => {
    const log = createTestLogger()
    const reaped = await reapStaleCoreProcesses({
      logger: log,
      ownPid: 1,
      coreExe: CORE_EXE,
      list: async () => {
        throw new Error('powershell 不可用')
      },
    })
    expect(reaped).toEqual([])
    expect(log.records.some((r) => r.level === 'warn')).toBe(true)
  })

  test('上一代 Core 被清理；单个清理失败也不影响继续', async () => {
    const log = createTestLogger()
    const killed: number[] = []
    const reaped = await reapStaleCoreProcesses({
      logger: log,
      ownPid: undefined,
      coreExe: CORE_EXE,
      list: async () => [
        proc({ pid: 4242, commandLine: 'poietica-core.exe serve --data-root C:\\d' }),
        proc({ pid: 4243, commandLine: 'poietica-core.exe __omp_worker_daemon_broker' }),
      ],
      kill: async (pid) => {
        if (pid === 4243) throw new Error('拒绝访问')
        killed.push(pid)
      },
    })
    expect(reaped.map((r) => r.pid)).toEqual([4242, 4243])
    expect(killed).toEqual([4242])
    expect(log.records.some((r) => JSON.stringify(r).includes('清理残留进程失败'))).toBe(true)
  })

  test('ownPid 指向的那一代不被杀（本代 Core 正活着）', async () => {
    const killed: number[] = []
    const reaped = await reapStaleCoreProcesses({
      logger: createTestLogger(),
      ownPid: 777,
      coreExe: CORE_EXE,
      list: async () => [proc({ pid: 777 }), proc({ pid: 778 })],
      kill: async (pid) => {
        killed.push(pid)
      },
    })
    expect(reaped.map((r) => r.pid)).toEqual([778])
    expect(killed).toEqual([778])
  })

  test('没有残留时不杀任何人', async () => {
    const log = createTestLogger()
    const killed: number[] = []
    const reaped = await reapStaleCoreProcesses({
      logger: log,
      ownPid: 5,
      coreExe: CORE_EXE,
      list: async () => [proc({ pid: 5, commandLine: 'poietica-core.exe serve' })],
      kill: async (pid) => {
        killed.push(pid)
      },
    })
    expect(reaped).toEqual([])
    expect(killed).toEqual([])
  })
})
