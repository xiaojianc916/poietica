import { describe, expect, test } from 'bun:test'
import { cimListScript, parseProcessList, parseTasklistCsv } from '../list-processes'

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

  /*
   * PowerShell 的 ConvertTo-Json 保留 Win32_Process 属性的原始大小写（Name / ExecutablePath / CommandLine），
   * 只有 Select-Object 的两个计算属性是我们自己起的小写名。只认小写会让 name / path / commandLine 全部变成空串，
   * 于是 core-reaper 按路径认不出任何残留 —— 这个用例锁住真实输出的形状。
   */
  test('PowerShell 真实输出的大小写（Name / ExecutablePath / CommandLine）也要认', () => {
    const row = {
      pid: 38764,
      parentPid: 25172,
      Name: 'poietica-core.exe',
      ExecutablePath: CORE_EXE,
      CommandLine: 'poietica-core.exe __omp_worker_daemon_broker',
    }
    expect(parseProcessList(JSON.stringify(row))).toEqual([
      {
        pid: 38764,
        parentPid: 25172,
        name: 'poietica-core.exe',
        executablePath: CORE_EXE,
        commandLine: 'poietica-core.exe __omp_worker_daemon_broker',
      },
    ])
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
    const parsed = parseProcessList('[{"Name":"x"},{"pid":9,"Name":"y"}]')
    expect(parsed).toEqual([{ pid: 9, parentPid: 0, name: 'y', executablePath: '', commandLine: '' }])
  })
})

describe('parseTasklistCsv', () => {
  test('每个进程一行 CSV：取映像名与 PID（内存列里的千分位逗号在引号内，不打乱字段）', () => {
    const out = [
      '"poietica-core.exe","38764","Console","1","123,456 K"',
      '"poietica-core.exe","40112","Console","1","8,192 K"',
    ].join('\r\n')
    expect(parseTasklistCsv(out)).toEqual([
      { name: 'poietica-core.exe', pid: 38764 },
      { name: 'poietica-core.exe', pid: 40112 },
    ])
  })

  test('没有匹配时只有一行本地化的提示：不是 CSV 行，交空表', () => {
    expect(parseTasklistCsv('INFO: No tasks are running which match the specified criteria.\r\n')).toEqual([])
    expect(parseTasklistCsv('信息: 没有运行的任务匹配指定标准。\r\n')).toEqual([])
    expect(parseTasklistCsv('')).toEqual([])
  })

  test('PID 读不成正整数的行丢掉', () => {
    expect(parseTasklistCsv('"x.exe","N/A","Services","0","0 K"\n"","12","","",""')).toEqual([])
  })
})

describe('cimListScript', () => {
  test('不给映像名：整表', () => {
    const script = cimListScript(undefined)
    expect(script).toContain('Get-CimInstance -ClassName Win32_Process |')
    expect(script).not.toContain('-Filter')
  })

  test("给了映像名：WQL 过滤式写在 PowerShell 单引号串里（'' 转义），不引入双引号", () => {
    const script = cimListScript('poietica-core.exe')
    expect(script).toContain(`-Filter 'Name=''poietica-core.exe'''`)
    const filter = script.slice(script.indexOf('-Filter'), script.indexOf('| Select-Object'))
    expect(filter).not.toContain('"')
  })
})
