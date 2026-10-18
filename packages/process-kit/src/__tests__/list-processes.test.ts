import { describe, expect, test } from 'bun:test'
import { parseProcessList } from '../list-processes'

const CORE_EXE = String.raw`D:\WindowsApp\Poietica\resources\core\poietica-core.exe`

describe('parseProcessList', () => {
  test('单个进程时 ConvertTo-Json 给的是对象，也要认', () => {
    const row = {
      pid: 38764,
      parentPid: 25172,
      name: 'poietica-core.exe',
      executablePath: CORE_EXE,
      commandLine: 'poietica-core.exe __omp_worker_daemon_broker',
    }
    expect(parseProcessList(JSON.stringify(row))).toEqual([row])
  })

  test('多个进程时是数组；缺字段按空串补齐', () => {
    const rows = [
      { pid: 1, parentPid: 0, name: 'a.exe' },
      { pid: 2, parentPid: 1, name: 'b.exe', executablePath: 'C:\\\\b.exe', commandLine: 'b --x' },
    ]
    const parsed = parseProcessList(JSON.stringify(rows))
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toEqual({ pid: 1, parentPid: 0, name: 'a.exe', executablePath: '', commandLine: '' })
    expect(parsed[1]?.executablePath).toBe('C:\\\\b.exe')
  })

  test('空输出（一个进程都没有）返回空表，不抛错', () => {
    expect(parseProcessList('')).toEqual([])
    expect(parseProcessList('   \n')).toEqual([])
  })

  test('没有 pid 的行被丢掉', () => {
    expect(parseProcessList('[{"name":"x"},{"pid":9,"name":"y"}]')).toHaveLength(1)
  })
})
