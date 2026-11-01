import { describe, expect, mock, test } from 'bun:test'
import { openExternal } from '../open-browser'

describe('系统浏览器', () => {
  test('把完整 URL 交给 Electron 原生系统调用', async () => {
    const shell = { openExternal: mock(async (_url: string) => undefined) }
    await openExternal(shell, 'https://example.test/login?a=1&b=2')
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.test/login?a=1&b=2')
  })

  test('系统调用失败时把错误交给界面，不伪报成功', async () => {
    const shell = {
      openExternal: mock(async (_url: string) => {
        throw new Error('启动失败')
      }),
    }
    await expect(openExternal(shell, 'https://example.test/login?a=1&b=2')).rejects.toThrow('启动失败')
  })
})
