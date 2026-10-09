import { describe, expect, test } from 'bun:test'
import { resolveShell, terminalEnv } from '../shell'

const findOnly =
  (...available: readonly string[]) =>
  async (name: string): Promise<string | null> => {
    const hit = available.find((a) => a.toLowerCase() === name.toLowerCase())
    return hit === undefined ? null : `C:\\Program Files\\PowerShell\\7\\${hit}`
  }

describe('TM-1: resolveShell', () => {
  test('只找到 powershell.exe', async () => {
    const shell = await resolveShell({}, findOnly('powershell.exe'))
    expect(shell.title).toBe('powershell')
    expect(shell.args).toEqual(['-NoLogo'])
    expect(shell.file).toContain('powershell.exe')
  })

  test('pwsh.exe 优先于 powershell.exe', async () => {
    const shell = await resolveShell({}, findOnly('pwsh.exe', 'powershell.exe'))
    expect(shell.title).toBe('pwsh')
    expect(shell.args).toEqual(['-NoLogo'])
  })

  test('什么都不找到、无 ComSpec 时落到 System32\\cmd.exe', async () => {
    const shell = await resolveShell({}, findOnly())
    expect(shell.title).toBe('cmd')
    expect(shell.args).toEqual([])
    expect(shell.file.endsWith('System32\\cmd.exe')).toBe(true)
  })

  test('SystemRoot 有值时兜底路径跟着它走', async () => {
    const shell = await resolveShell({ SystemRoot: 'D:\\Win' }, findOnly())
    expect(shell.file).toBe('D:\\Win\\System32\\cmd.exe')
  })

  test('ComSpec 有值时排在两个 PowerShell 之后、cmd.exe 之前', async () => {
    const shell = await resolveShell({ ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, findOnly())
    expect(shell.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(shell.title).toBe('cmd')
  })

  test('ComSpec 只在两个 PowerShell 都不存在时生效', async () => {
    const shell = await resolveShell({ ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, findOnly('powershell.exe'))
    expect(shell.title).toBe('powershell')
  })
})

describe('TM-2: terminalEnv', () => {
  test('去掉 ELECTRON_* / POIETICA_* / NODE_OPTIONS，保留其它变量', () => {
    const env = terminalEnv({
      PATH: 'C:\\Windows',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      POIETICA_X: 'y',
      POIETICA_DATA_ROOT: 'C:\\data',
      NODE_OPTIONS: '--inspect',
      SystemRoot: 'C:\\Windows',
    })
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(env).not.toHaveProperty('ELECTRON_NO_ATTACH_CONSOLE')
    expect(env).not.toHaveProperty('POIETICA_X')
    expect(env).not.toHaveProperty('POIETICA_DATA_ROOT')
    expect(env).not.toHaveProperty('NODE_OPTIONS')
    expect(env.PATH).toBe('C:\\Windows')
    expect(env.SystemRoot).toBe('C:\\Windows')
  })

  test('加三个终端能力声明', () => {
    const env = terminalEnv({})
    expect(env.TERM).toBe('xterm-256color')
    expect(env.COLORTERM).toBe('truecolor')
    expect(env.TERM_PROGRAM).toBe('Poietica')
  })
})
