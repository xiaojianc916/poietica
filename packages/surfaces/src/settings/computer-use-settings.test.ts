import { describe, expect, it } from 'bun:test'
import { computerUseFailureDescription } from './computer-use-settings'

describe('computerUseFailureDescription', () => {
  it('turns the official PowerShell preflight failure into actionable recovery', () => {
    const reason =
      'Kimi Computer Use requires Windows PowerShell 5.1 or PowerShell 7 with the commands required by its official installer. Windows PowerShell: missing commands: Get-FileHash; PowerShell 7: spawn ENOENT'

    expect(computerUseFailureDescription(reason)).toBe(
      '安装失败：Windows PowerShell 缺少 Kimi 官方安装器所需命令，且未检测到 PowerShell 7。安装 PowerShell 7，重启 Poietica 后重试。',
    )
  })

  it('keeps unknown upstream failures visible', () => {
    expect(computerUseFailureDescription('runtime failed')).toBe('安装失败：runtime failed')
  })
})
