import { describe, expect, test } from 'bun:test'
import type { AppError } from '@poietica/foundation'
import { createTestLogger } from '@poietica/test-kit'
import { ASSET_SCHEME, createAssetDispatcher } from '../asset-protocol'

describe('poietica-asset:// 分派', () => {
  test('按 host 分派到处理器，路径段已解码', async () => {
    const d = createAssetDispatcher(createTestLogger())
    const seen: string[][] = []
    d.register('attachments', 'attachment', (segments) => {
      seen.push([...segments])
      return new Response('ok', { status: 200 })
    })
    const res = await d.dispatch(new Request(`${ASSET_SCHEME}://attachment/ab%20cd/file.png`))
    expect(res.status).toBe(200)
    expect(seen).toEqual([['ab cd', 'file.png']])
  })

  test('未注册的 host → 404', async () => {
    const d = createAssetDispatcher(createTestLogger())
    expect((await d.dispatch(new Request(`${ASSET_SCHEME}://nope/x`))).status).toBe(404)
  })

  test('重复注册同一个 host → kernel.conflict', () => {
    const d = createAssetDispatcher(createTestLogger())
    d.register('a', 'attachment', () => new Response(null))
    try {
      d.register('b', 'attachment', () => new Response(null))
    } catch (e) {
      expect((e as AppError).code).toBe('kernel.conflict')
      expect((e as AppError).message).toContain('a')
    }
  })

  test('host 名不合法 → kernel.invalid_params', () => {
    const d = createAssetDispatcher(createTestLogger())
    try {
      d.register('a', 'Attachment', () => new Response(null))
    } catch (e) {
      expect((e as AppError).code).toBe('kernel.invalid_params')
    }
  })

  test('非 GET → 405', async () => {
    const d = createAssetDispatcher(createTestLogger())
    d.register('a', 'attachment', () => new Response('x'))
    expect((await d.dispatch(new Request(`${ASSET_SCHEME}://attachment/x`, { method: 'POST' }))).status).toBe(405)
  })

  test('路径穿越（..）被拒绝', async () => {
    const d = createAssetDispatcher(createTestLogger())
    let called = false
    d.register('a', 'attachment', () => {
      called = true
      return new Response('x')
    })
    const res = await d.dispatch(new Request(`${ASSET_SCHEME}://attachment/..%2Fsecret`))
    expect(res.status).toBe(400)
    expect(called).toBe(false)
  })

  test('处理器抛错 → 500 并记 error', async () => {
    const logger = createTestLogger()
    const d = createAssetDispatcher(logger)
    d.register('a', 'attachment', () => {
      throw new Error('坏了')
    })
    expect((await d.dispatch(new Request(`${ASSET_SCHEME}://attachment/x`))).status).toBe(500)
    expect(logger.at('error').some((r) => r.msg === 'asset handler failed')).toBe(true)
  })

  test('成功的响应加上 nosniff 与 immutable 缓存头', async () => {
    const d = createAssetDispatcher(createTestLogger())
    d.register('a', 'attachment', () => new Response('x'))
    const res = await d.dispatch(new Request(`${ASSET_SCHEME}://attachment/x`))
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Cache-Control')).toContain('immutable')
  })
})
