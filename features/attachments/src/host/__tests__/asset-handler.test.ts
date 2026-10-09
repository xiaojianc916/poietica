import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from '@poietica/fs-kit'
import { tempDir } from '@poietica/test-kit'
import { createAttachmentAssetHandler } from '../asset-handler'

const SHA = 'a'.repeat(64)
const FILE_SHA = 'b'.repeat(64)

async function make() {
  const root = await tempDir('asset-')
  const dir = path.join(root.path, 'attachments')
  await ensureDir(path.join(dir, FILE_SHA.slice(0, 2)))
  fs.writeFileSync(path.join(dir, FILE_SHA.slice(0, 2), FILE_SHA), 'PNG')
  const handler = createAttachmentAssetHandler({ attachmentsDir: dir })
  return { handler, dir, root }
}

const URL_FOR = (s: string, mime?: string): Request =>
  new Request(`poietica-asset://attachment/${s}${mime === undefined ? '' : `?mime=${encodeURIComponent(mime)}`}`)

describe('attachments 预览协议（07 页 §4D）', () => {
  test('attachment/abc（不是 64 位 sha）→ 400', async () => {
    const { handler, root } = await make()
    expect((await handler(['abc'], URL_FOR('abc'))).status).toBe(400)
    await root.dispose()
  })

  test('段数不对 → 400', async () => {
    const { handler, root } = await make()
    expect((await handler([], URL_FOR(''))).status).toBe(400)
    expect((await handler([FILE_SHA, 'extra'], URL_FOR(FILE_SHA))).status).toBe(400)
    await root.dispose()
  })

  test('合法 sha 但文件不存在 → 404', async () => {
    const { handler, root } = await make()
    expect((await handler([SHA], URL_FOR(SHA))).status).toBe(404)
    await root.dispose()
  })

  test('?mime=image/png → 内联返回 image/png', async () => {
    const { handler, root } = await make()
    const res = await handler([FILE_SHA], URL_FOR(FILE_SHA, 'image/png'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(await res.text()).toBe('PNG')
    await root.dispose()
  })

  test('?mime=text/html → application/octet-stream（未知 mime 一律不内联）', async () => {
    const { handler, root } = await make()
    const res = await handler([FILE_SHA], URL_FOR(FILE_SHA, 'text/html'))
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    await root.dispose()
  })

  test('没有 mime 参数 → application/octet-stream', async () => {
    const { handler, root } = await make()
    const res = await handler([FILE_SHA], URL_FOR(FILE_SHA))
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    await root.dispose()
  })

  test("?mime=image/svg+xml → 响应头含 CSP default-src 'none'", async () => {
    const { handler, root } = await make()
    const res = await handler([FILE_SHA], URL_FOR(FILE_SHA, 'image/svg+xml'))
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml')
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    await root.dispose()
  })

  test('application/pdf 与 text/plain 在放行名单里', async () => {
    const { handler, root } = await make()
    expect((await handler([FILE_SHA], URL_FOR(FILE_SHA, 'application/pdf'))).headers.get('Content-Type')).toBe(
      'application/pdf',
    )
    expect((await handler([FILE_SHA], URL_FOR(FILE_SHA, 'text/plain'))).headers.get('Content-Type')).toBe('text/plain')
    await root.dispose()
  })

  test('sha 里的 ../ 无法逃出附件目录（形状先被 sha 正则挡掉）', async () => {
    const { handler, root } = await make()
    expect((await handler(['../../etc/passwd'], URL_FOR('x'))).status).toBe(400)
    await root.dispose()
  })
})
