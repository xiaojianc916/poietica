import { describe, expect, test } from 'bun:test'
import { AppError } from '@poietica/foundation'
import { platformErrors } from '../../contract/errors'
import { createShellService } from '../shell-service'

function make(overrides: Partial<Parameters<typeof createShellService>[0]> = {}) {
  const calls: string[] = []
  const service = createShellService({
    shell: {
      openExternal: async (url) => {
        calls.push(`external:${url}`)
      },
      openPath: async () => '',
      showItemInFolder: (p) => {
        calls.push(`show:${p}`)
      },
      trashItem: async (p) => {
        calls.push(`trash:${p}`)
      },
    },
    exists: () => true,
    ...overrides,
  })
  return { service, calls }
}

describe('shell-service', () => {
  test('http / https / mailto 放行', async () => {
    const { service, calls } = make()
    await service.openExternal('https://a.com')
    await service.openExternal('http://a.com')
    await service.openExternal('mailto:x@y.com')
    expect(calls).toEqual(['external:https://a.com', 'external:http://a.com', 'external:mailto:x@y.com'])
  })

  test('file: / javascript: / 无法解析的地址一律拒绝，且不调用 shell', async () => {
    for (const url of ['file:///C:/x', 'javascript:alert(1)', 'not a url', 'data:text/html,x']) {
      const { service, calls } = make()
      const err = await service.openExternal(url).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe(platformErrors.url_not_allowed)
      expect(calls).toEqual([])
    }
  })

  test('openPath 返回非空串 → platform.path_not_found 并带上原信息', async () => {
    const s = createShellService({
      shell: {
        openExternal: async () => undefined,
        openPath: async () => 'Failed',
        showItemInFolder: () => undefined,
        trashItem: async () => undefined,
      },
      exists: () => true,
    })
    const err = await s.openPath('C:/nope').catch((e: unknown) => e)
    expect((err as AppError).code).toBe(platformErrors.path_not_found)
    expect((err as AppError).message).toContain('Failed')
  })

  test('路径不存在 → platform.path_not_found，未调用 shell', async () => {
    const calls: string[] = []
    const s = createShellService({
      shell: {
        openExternal: async () => undefined,
        openPath: async (p) => {
          calls.push(p)
          return ''
        },
        showItemInFolder: () => undefined,
        trashItem: async () => undefined,
      },
      exists: () => false,
    })
    const err = await s.openPath('C:/nope').catch((e: unknown) => e)
    expect((err as AppError).code).toBe(platformErrors.path_not_found)
    expect(calls).toEqual([])
  })

  test('trashItem 失败 → platform.trash_failed', async () => {
    const s = createShellService({
      shell: {
        openExternal: async () => undefined,
        openPath: async () => '',
        showItemInFolder: () => undefined,
        trashItem: async () => {
          throw new Error('被占用')
        },
      },
      exists: () => true,
    })
    const err = await s.trashItem('C:/x').catch((e: unknown) => e)
    expect((err as AppError).code).toBe(platformErrors.trash_failed)
    expect((err as AppError).message).toContain('被占用')
  })

  test('showInFolder 路径不存在 → path_not_found', () => {
    const s = createShellService({
      shell: {
        openExternal: async () => undefined,
        openPath: async () => '',
        showItemInFolder: () => undefined,
        trashItem: async () => undefined,
      },
      exists: () => false,
    })
    try {
      s.showInFolder('C:/nope')
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as AppError).code).toBe(platformErrors.path_not_found)
    }
  })
})
