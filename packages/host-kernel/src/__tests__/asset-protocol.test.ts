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

  test('坏的百分号编码、NUL → 400，处理器不被调用（旧代码 URIError 直接让 dispatch 拒绝）', async () => {
    const d = createAssetDispatcher(createTestLogger())
    let called = false
    d.register('a', 'attachment', () => {
      called = true
      return new Response('x')
    })
    for (const tail of ['%E0%A4%A', 'a%00b']) {
      expect((await d.dispatch(new Request(`${ASSET_SCHEME}://attachment/${tail}`))).status).toBe(400)
    }
    expect(called).toBe(false)
  })

  test('处理器的非 2xx 响应 → no-store：「还没取到」的 404 不能被当成一年有效的答案', async () => {
    const d = createAssetDispatcher(createTestLogger())
    d.register('a', 'attachment', () => new Response(null, { status: 404 }))
    const res = await d.dispatch(new Request(`${ASSET_SCHEME}://attachment/x`))
    expect(res.status).toBe(404)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  test('处理器自己写的 Cache-Control 照用（缓存策略归处理器）', async () => {
    const d = createAssetDispatcher(createTestLogger())
    d.register('a', 'attachment', () => new Response('x', { headers: { 'Cache-Control': 'no-cache' } }))
    const res = await d.dispatch(new Request(`${ASSET_SCHEME}://attachment/x`))
    expect(res.headers.get('Cache-Control')).toBe('no-cache')
  })

  test('响应头不可变（fetch() 的结果）也照常加头，不变成 500', async () => {
    const d = createAssetDispatcher(createTestLogger())
    d.register('a', 'attachment', () => {
      const res = new Response('body', { status: 200, headers: { 'Content-Type': 'image/png' } })
      // undici 的 fetch 结果头是 immutable guard：模拟它，原地 set 会抛 TypeError
      const frozen = new Headers(res.headers)
      frozen.set = () => {
        throw new TypeError('immutable')
      }
      Object.defineProperty(res, 'headers', { value: frozen })
      return res
    })
    const res = await d.dispatch(new Request(`${ASSET_SCHEME}://attachment/x`))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(await res.text()).toBe('body')
  })

  test('成功的响应加上 nosniff 与 immutable 缓存头', async () => {
    const d = createAssetDispatcher(createTestLogger())
    d.register('a', 'attachment', () => new Response('x'))
    const res = await d.dispatch(new Request(`${ASSET_SCHEME}://attachment/x`))
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Cache-Control')).toContain('immutable')
  })
})
