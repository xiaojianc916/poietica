import { describe, expect, it } from 'bun:test'
import { computerUseFailureDescription } from './computer-use-settings'

describe('computerUseFailureDescription', () => {
  it('preserves upstream PowerShell diagnostics instead of inventing recovery', () => {
    const reason =
      'Kimi Computer Use requires Windows PowerShell 5.1 or PowerShell 7 with the commands required by its official installer. Windows PowerShell: missing commands: Get-FileHash; PowerShell 7: spawn ENOENT'

    expect(computerUseFailureDescription(reason)).toBe(`安装失败：${reason}`)
  })

  it('emits exactly one failure prefix', () => {
    expect(computerUseFailureDescription('安装失败：安装失败：runtime failed')).toBe(
      '安装失败：runtime failed',
    )
  })

  it('keeps unknown upstream failures visible', () => {
    expect(computerUseFailureDescription('runtime failed')).toBe('安装失败：runtime failed')
  })

  it('does not render an empty failure', () => {
    expect(computerUseFailureDescription('   ')).toBe('安装失败：Kimi Code 未提供失败原因。')
  })
})
