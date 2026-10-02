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

/** 一份可控的字节源：记下被问了什么，回答什么由每个用例自己定。 */
function sourceOf(
  answer: (
    sessionToken: string,
    assetToken: string,
  ) => { contentType: string; bytes: Buffer } | null,
): AssetByteSource & { readonly asked: readonly (readonly [string, string])[] } {
  const asked: Array<readonly [string, string]> = []

  return {
    asked,
    read(sessionToken, assetToken) {
      asked.push([sessionToken, assetToken])

      return Promise.resolve(answer(sessionToken, assetToken))
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
    expect(source.asked).toEqual([[SESSION, HASH]])
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

  test('cuts the range itself: the bytes arrive whole, so a seek needs a 206', async () => {
    const bytes = Buffer.from('0123456789')
    const source = sourceOf(() => ({ contentType: 'image/png', bytes }))

    const response = await serve(source, `poietica-asset://asset/${SESSION}/${HASH}`, {
      range: 'bytes=2-5',
    })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(response.headers.get('content-length')).toBe('4')
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('2345')
  })

  test('an open-ended range runs to the end', async () => {
    const bytes = Buffer.from('0123456789')
    const source = sourceOf(() => ({ contentType: 'image/png', bytes }))

    const response = await serve(source, `poietica-asset://asset/${SESSION}/${HASH}`, {
      range: 'bytes=7-',
    })

    expect(response.status).toBe(206)
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('789')
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
