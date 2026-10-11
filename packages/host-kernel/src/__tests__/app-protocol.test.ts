import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { APP_ENTRY_URL, APP_SCHEME, createAppProtocolHandler } from '../app-protocol'

/*
 * P-06：poietica-app://shell 只把 URL 安全地映射到 rendererDir 里的文件。
 * 读文件是注入的（安装版是 net.fetch(file://…)），这里记下它被要求读哪个路径。
 */

const ROOT = path.resolve('/app/out/renderer')

function open() {
  const asked: string[] = []
  const handler = createAppProtocolHandler(ROOT, async (file) => {
    asked.push(file)
    if (file.endsWith('missing.js')) throw new TypeError('net::ERR_FILE_NOT_FOUND')
    return new Response('body', { status: 200, headers: { 'Content-Type': 'text/javascript' } })
  })
  return { asked, handler }
}

const get = (url: string, init?: RequestInit) => new Request(url, init)

describe('P-06 poietica-app:// 外壳协议', () => {
  test('A1 入口地址映射到 rendererDir/index.html，并加 nosniff、保留原 Content-Type', async () => {
    const { asked, handler } = open()
    const res = await handler(get(APP_ENTRY_URL))
    expect(res.status).toBe(200)
    expect(asked).toEqual([path.join(ROOT, 'index.html')])
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Content-Type')).toBe('text/javascript')
    expect(await res.text()).toBe('body')
  })

  test('A2 子目录与编码过的文件名：逐段解码后拼进 rendererDir', async () => {
    const { asked, handler } = open()
    await handler(get(`${APP_SCHEME}://shell/assets/KaTeX%20Main.woff2`))
    expect(asked).toEqual([path.join(ROOT, 'assets', 'KaTeX Main.woff2')])
  })

  test('A3 不是 shell 这个 host → 404，不读文件', async () => {
    const { asked, handler } = open()
    expect((await handler(get(`${APP_SCHEME}://other/index.html`))).status).toBe(404)
    expect(asked).toEqual([])
  })

  test('A4 编码过的斜杠 / 反斜杠 / 空字符 → 400，不读文件', async () => {
    const { asked, handler } = open()
    for (const evil of ['..%2Fsecret', '..%5Csecret', 'a%00b']) {
      expect((await handler(get(`${APP_SCHEME}://shell/assets/${evil}`))).status).toBe(400)
    }
    expect(asked).toEqual([])
  })

  test('A5 字面量或编码的 .. 都出不了 rendererDir', async () => {
    const { asked, handler } = open()
    for (const evil of ['../../etc/passwd', '%2e%2e/%2e%2e/etc/passwd']) {
      await handler(get(`${APP_SCHEME}://shell/${evil}`))
    }
    for (const file of asked) expect(path.relative(ROOT, file).startsWith('..')).toBe(false)
  })

  test('A6 非 GET → 405；坏的百分号编码 → 400；根路径 → 404', async () => {
    const { handler } = open()
    expect((await handler(get(APP_ENTRY_URL, { method: 'POST' }))).status).toBe(405)
    expect((await handler(get(`${APP_SCHEME}://shell/%E0%A4%A`))).status).toBe(400)
    expect((await handler(get(`${APP_SCHEME}://shell/`))).status).toBe(404)
  })

  test('A7 文件不存在（读取抛错）→ 404', async () => {
    const { handler } = open()
    expect((await handler(get(`${APP_SCHEME}://shell/assets/missing.js`))).status).toBe(404)
  })
})
