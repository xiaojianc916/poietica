import { describe, expect, test } from 'bun:test'
import { browserCommand } from '../open-browser'

describe('系统浏览器命令', () => {
  test('Windows 用 System32 的 rundll32，与 magpie 的 proc.OpenBrowser 一致', () => {
    const systemRoot = process.env.SystemRoot
    expect(browserCommand('https://example.test/login?a=1&b=2')).toEqual({
      file: systemRoot === undefined ? 'rundll32' : `${systemRoot}\\System32\\rundll32.exe`,
      args: ['url.dll,FileProtocolHandler', 'https://example.test/login?a=1&b=2'],
    })
  })
})
