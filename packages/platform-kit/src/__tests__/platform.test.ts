import { describe, expect, test } from 'bun:test'
import {
  defaultPathExtensions,
  familyOf,
  isExecutableName,
  platformLabel,
  resolveShell,
  stripExecutable,
  windowsExecutable,
} from '../index'

describe('platform-kit', () => {
  test('平台家族与标签收敛成一个映射', () => {
    expect(familyOf('win32')).toBe('windows')
    expect(familyOf('darwin')).toBe('macos')
    expect(familyOf('linux')).toBe('linux')
    expect(platformLabel('freebsd')).toBe('Other:freebsd')
  })

  test('可执行名与 PATH 候选只在能力包里拼', () => {
    expect(windowsExecutable('poietica-core')).toBe('poietica-core.exe')
    expect(windowsExecutable('taskkill.exe')).toBe('taskkill.exe')
    expect(stripExecutable('PowerShell.EXE')).toBe('PowerShell')
    expect(isExecutableName('tool.exe')).toBe(true)
    expect(defaultPathExtensions()).toEqual(['.COM', '.EXE', '.BAT', '.CMD'])
  })

  test('shell 选择按 pwsh → powershell → ComSpec → cmd 的优先级', async () => {
    const says = async (name: string) => (name === 'pwsh.exe' ? 'C:\\pwsh.exe' : null)
    expect(await resolveShell({}, says)).toMatchObject({ file: 'C:\\pwsh.exe', title: 'pwsh' })

    const comspec = async () => null
    expect(await resolveShell({ ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, comspec)).toMatchObject({
      file: 'C:\\Windows\\System32\\cmd.exe',
      title: 'cmd',
    })
    expect(await resolveShell({}, comspec)).toMatchObject({ title: 'cmd' })
  })
})
