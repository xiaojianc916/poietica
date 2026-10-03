import { describe, expect, test } from 'bun:test'

import { type AssetByteSource, createAssetProtocolHandler } from './asset-protocol'

/*
 * 资产协议的自检。地址形状的正本是 crates/asset/src/delivery.rs 的 asset_protocol_url。
 *
 * 这里曾经按 <dataRoot>/attachments/<hash 前两位>/<hash> 读磁盘。那是错的：图片进门时
 * 进的是**内存注册表**（crates/asset/src/intake.rs 的 commit 只给 ImportedKind::File 落盘），
 * 磁盘上什么都没有 —— 表现就是每一张图都 404。这些用例把「字节从哪来」钉在取字节的那一层。
 */

const SESSION = '01a0f884bf1375af9264547e6b8260b0'
const HASH = 'a'.repeat(64)

/** 一次取字节的请求：令牌 + 被要的那一段（缺省即整份）。 */
type Ask = readonly [
  string,
  string,
  { readonly start: number; readonly length: number } | undefined,
]

/**
 * 一份可控的字节源：记下被问了什么，回答什么由每个用例自己定。
 *
 * 它**自己按 range 切片**，与原生侧 asset_read 的行为同形 —— 处理器不再切片，
 * 所以「Range 只付这一段的价」这条性质只有在这里模拟出来才测得到。
 */
function sourceOf(
  answer: (
    sessionToken: string,
    assetToken: string,
  ) => { contentType: string; bytes: Buffer } | null,
): AssetByteSource & { readonly asked: readonly Ask[] } {
  const asked: Ask[] = []

  return {
    asked,
    read(sessionToken, assetToken, range) {
      asked.push([sessionToken, assetToken, range])

      const full = answer(sessionToken, assetToken)

      if (full === null) {
        return Promise.resolve(null)
      }

      const totalLength = full.bytes.byteLength

      if (range === undefined) {
        return Promise.resolve({ ...full, totalLength })
      }

      return Promise.resolve({
        contentType: full.contentType,
        bytes: full.bytes.subarray(range.start, range.start + range.length),
        totalLength,
      })
    },
  }
}

const serve = (source: AssetByteSource, url: string, headers?: Record<string, string>) =>
  createAssetProtocolHandler(source)(new Request(url, headers === undefined ? {} : { headers }))

describe('asset protocol', () => {
  test('serves the bytes the native registry holds, not a file on disk', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const source = sourceOf(() => ({ contentType: 'image/png', bytes }))

    const response = await serve(source, `poietica-asset://asset/${SESSION}/${HASH}`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength))
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    expect(source.asked).toEqual([[SESSION, HASH, undefined]])
  })

  test('a missing asset is a 404, not an empty body', async () => {
    const source = sourceOf(() => null)
    const response = await serve(source, `poietica-asset://asset/${SESSION}/${HASH}`)

    expect(response.status).toBe(404)
  })

  test('a registry that cannot answer is a 500, not a 404', async () => {
    const source: AssetByteSource = {
      read: () => Promise.reject(new Error('native host is gone')),
    }
    const response = await serve(source, `poietica-asset://asset/${SESSION}/${HASH}`)

    expect(response.status).toBe(500)
  })

  test('a range is asked for before the bytes are fetched, and answered with a 206', async () => {
    const bytes = Buffer.from('0123456789')
    const source = sourceOf(() => ({ contentType: 'image/png', bytes }))

    const response = await serve(source, `poietica-asset://asset/${SESSION}/${HASH}`, {
      range: 'bytes=2-5',
    })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(response.headers.get('content-length')).toBe('4')
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('2345')
    /* 这一段就是「一次 seek 不付整份的价」：请求里带着区间，源只交回这一段。 */
    expect(source.asked).toEqual([[SESSION, HASH, { start: 2, length: 4 }]])
  })

  test('an open-ended range asks for everything from the start', async () => {
    const bytes = Buffer.from('0123456789')
    const source = sourceOf(() => ({ contentType: 'image/png', bytes }))

    const response = await serve(source, `poietica-asset://asset/${SESSION}/${HASH}`, {
      range: 'bytes=7-',
    })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 7-9/10')
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('789')
  })

  test('a suffix range still answers correctly, falling back to the whole asset', async () => {
    const bytes = Buffer.from('0123456789')
    const source = sourceOf(() => ({ contentType: 'image/png', bytes }))

    const response = await serve(source, `poietica-asset://asset/${SESSION}/${HASH}`, {
      range: 'bytes=-3',
    })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 7-9/10')
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('789')
    /* 后缀式算不出起点，只能取整份 —— 这是刻意的退化，钉在这里免得被当成回归。 */
    expect(source.asked).toEqual([[SESSION, HASH, undefined]])
  })

  test('a range past the end yields an empty 206 rather than a broken image', async () => {
    const bytes = Buffer.from('0123456789')
    const source = sourceOf(() => ({ contentType: 'image/png', bytes }))

    const response = await serve(source, `poietica-asset://asset/${SESSION}/${HASH}`, {
      range: 'bytes=100-200',
    })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 100-99/10')
    expect(response.headers.get('content-length')).toBe('0')
  })

  test('a shape that is not the canonical address never reaches the registry', async () => {
    const source = sourceOf(() => ({ contentType: 'image/png', bytes: Buffer.from('x') }))
    const rejected = [
      /* 旧形状：全仓没有地方产出过它，留着等于第二条取字节的路。 */
      `poietica-asset://blob/${HASH}`,
      /* 段数不对。 */
      `poietica-asset://asset/${HASH}`,
      `poietica-asset://asset/${SESSION}/${HASH}/extra`,
      /* 令牌或摘要不合规。 */
      `poietica-asset://asset/${SESSION}/${'A'.repeat(64)}`,
      `poietica-asset://asset/${SESSION}/${'a'.repeat(63)}`,
      `poietica-asset://asset/bad token/${HASH}`,
      /* host 不对。 */
      `poietica-asset://other/${SESSION}/${HASH}`,
      /* 查询串：正本地址没有它。 */
      `poietica-asset://asset/${SESSION}/${HASH}?v=1`,
    ]

    for (const url of rejected) {
      const response = await serve(source, url)

      expect(response.status, url).toBe(400)
    }
    expect(source.asked).toEqual([])
  })
})
