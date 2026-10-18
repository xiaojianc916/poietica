import { describe, expect, test } from 'bun:test'
import { createTestLogger } from '@poietica/test-kit'
import { FAVICON_URL } from '../../contract/entities'
import { createFaviconStore, type FaviconFetch, faviconCandidates, sniffFaviconMime } from '../favicon'

/* 图标代取：真网络不参与，fetch 注入（index.ts 接的是浏览器分区的 session.fetch）。 */

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const ICO = Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16])
const SVG = new TextEncoder().encode('\uFEFF  <?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')
const HTML = new TextEncoder().encode('<!doctype html><html><body>404</body></html>')

function fakeFetch(routes: Record<string, Response | (() => Response) | Error>): FaviconFetch & { calls: string[] } {
  const calls: string[] = []
  const fn = (url: string) => {
    calls.push(url)
    const route = routes[url]

    if (route === undefined) return Promise.resolve(new Response(null, { status: 404 }))
    if (route instanceof Error) return Promise.reject(route)

    return Promise.resolve(typeof route === 'function' ? route() : route)
  }

  return Object.assign(fn, { calls })
}

const ok =
  (bytes: Uint8Array, type = 'application/octet-stream') =>
  () =>
    new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), { headers: { 'Content-Type': type } })

async function served(store: ReturnType<typeof createFaviconStore>, url: string | null) {
  expect(url).not.toBeNull()
  expect(url ?? '').toMatch(FAVICON_URL)

  const sha = (url ?? '').split('/').at(-1) ?? ''
  const res = await store.handler([sha], new Request(url ?? ''))

  return { res, bytes: new Uint8Array(await res.arrayBuffer()) }
}

describe('sniffFaviconMime', () => {
  test('按魔数认格式，不看扩展名与 Content-Type', () => {
    expect(sniffFaviconMime(PNG)).toBe('image/png')
    expect(sniffFaviconMime(ICO)).toBe('image/x-icon')
    expect(sniffFaviconMime(SVG)).toBe('image/svg+xml')
    expect(sniffFaviconMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffFaviconMime(new TextEncoder().encode('GIF89a'))).toBe('image/gif')
    expect(sniffFaviconMime(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
  })

  test('HTML 错误页、空内容不是图标', () => {
    expect(sniffFaviconMime(HTML)).toBeNull()
    expect(sniffFaviconMime(new Uint8Array())).toBeNull()
    expect(sniffFaviconMime(new TextEncoder().encode('<html><svg></svg></html>'))).toBeNull()
  })
})

describe('faviconCandidates', () => {
  test('只要 http(s) 与 data:image，去重、限量，末尾补站点根 /favicon.ico', () => {
    expect(
      faviconCandidates(
        [
          'https://a.example/x.png',
          'https://a.example/x.png',
          'javascript:alert(1)',
          'file:///etc/passwd',
          'data:text/html,<script>',
          'data:image/png;base64,AA==',
          'not a url',
        ],
        'https://a.example/path?q=1',
      ),
    ).toEqual(['https://a.example/x.png', 'data:image/png;base64,AA==', 'https://a.example/favicon.ico'])
  })

  test('页面不是网页就不补兜底', () => {
    expect(faviconCandidates([], 'about:blank')).toEqual([])
    expect(faviconCandidates([], null)).toEqual([])
  })
})

describe('createFaviconStore', () => {
  test('取回 → 内容寻址的受信地址；处理器按嗅出的类型回图', async () => {
    const fetch = fakeFetch({ 'https://a.example/i.ico': ok(ICO, 'text/plain') })
    const store = createFaviconStore({ fetch, logger: createTestLogger() })

    const url = await store.resolve(['https://a.example/i.ico'], 'https://a.example/')
    const { res, bytes } = await served(store, url)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/x-icon')
    expect(bytes).toEqual(ICO)
  })

  test('前一个候选失败（404 / 不是图片 / 断网）就试下一个，最后试 /favicon.ico', async () => {
    const fetch = fakeFetch({
      'https://a.example/html.png': ok(HTML, 'image/png'),
      'https://a.example/down.png': new Error('net::ERR_CONNECTION_RESET'),
      'https://a.example/favicon.ico': ok(PNG),
    })
    const store = createFaviconStore({ fetch, logger: createTestLogger() })

    const url = await store.resolve(
      ['https://a.example/missing.png', 'https://a.example/html.png', 'https://a.example/down.png'],
      'https://a.example/',
    )

    expect(url).toMatch(FAVICON_URL)
    expect(fetch.calls).toEqual([
      'https://a.example/missing.png',
      'https://a.example/html.png',
      'https://a.example/down.png',
      'https://a.example/favicon.ico',
    ])
  })

  test('都取不回来是 null，不抛错', async () => {
    const store = createFaviconStore({ fetch: fakeFetch({}), logger: createTestLogger() })

    expect(await store.resolve(['https://a.example/x.png'], 'https://a.example/')).toBeNull()
  })

  test('同一地址：并发只取一次，成功与确定的失败都记住；暂时的失败下次再试', async () => {
    let flaky = 0
    const fetch = fakeFetch({
      'https://a.example/x.png': ok(PNG),
      'https://a.example/flaky.png': () => {
        flaky += 1

        if (flaky === 1) throw new Error('timeout')

        return ok(PNG)()
      },
    })
    const store = createFaviconStore({ fetch, logger: createTestLogger() })

    const [first, second] = await Promise.all([
      store.resolve(['https://a.example/x.png'], null),
      store.resolve(['https://a.example/x.png'], null),
    ])

    expect(first).toBe(second)
    await store.resolve(['https://a.example/x.png'], null)
    await store.resolve(['https://a.example/gone.png'], null)
    await store.resolve(['https://a.example/gone.png'], null)
    expect(fetch.calls.filter((u) => u.endsWith('/x.png'))).toHaveLength(1)
    expect(fetch.calls.filter((u) => u.endsWith('/gone.png'))).toHaveLength(1)

    await store.resolve(['https://a.example/flaky.png'], null).catch(() => null)
    expect(await store.resolve(['https://a.example/flaky.png'], null)).toMatch(FAVICON_URL)
  })

  test('超过单张上限的不要（Content-Length 先报超了就不读）', async () => {
    const big = new Uint8Array(64)
    big.set(PNG)
    const fetch = fakeFetch({ 'https://a.example/big.png': ok(big) })
    const store = createFaviconStore({ fetch, logger: createTestLogger(), maxIconBytes: 32 })

    expect(await store.resolve(['https://a.example/big.png'], null)).toBeNull()
  })

  test('data:image 候选就地解码，不走网络', async () => {
    const fetch = fakeFetch({})
    const store = createFaviconStore({ fetch, logger: createTestLogger() })
    const data = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`

    const { bytes } = await served(store, await store.resolve([data], null))

    expect(bytes).toEqual(PNG)
    expect(fetch.calls).toEqual([])
  })

  test('SVG 回图时带 CSP；处理器只认 64 位十六进制、找不到 404', async () => {
    const store = createFaviconStore({
      fetch: fakeFetch({ 'https://a.example/i.svg': ok(SVG, 'image/svg+xml') }),
      logger: createTestLogger(),
    })
    const { res } = await served(store, await store.resolve(['https://a.example/i.svg'], null))

    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    expect((await store.handler(['../x'], new Request('poietica-asset://browser-favicon/x'))).status).toBe(400)
    expect((await store.handler(['f'.repeat(64)], new Request('poietica-asset://browser-favicon/x'))).status).toBe(404)
  })

  test('超出内存预算按最久未用淘汰；被淘汰的地址再要会重新取', async () => {
    const other = Uint8Array.from([...PNG, 9])
    const fetch = fakeFetch({ 'https://a.example/1.png': ok(PNG), 'https://a.example/2.png': ok(other) })
    const store = createFaviconStore({ fetch, logger: createTestLogger(), budgetBytes: PNG.byteLength + 4 })

    const first = await store.resolve(['https://a.example/1.png'], null)
    await store.resolve(['https://a.example/2.png'], null)

    const sha = (first ?? '').split('/').at(-1) ?? ''

    expect((await store.handler([sha], new Request(first ?? ''))).status).toBe(404)
    expect(await store.resolve(['https://a.example/1.png'], null)).toBe(first)
    expect(fetch.calls.filter((u) => u.endsWith('/1.png'))).toHaveLength(2)
  })
})
