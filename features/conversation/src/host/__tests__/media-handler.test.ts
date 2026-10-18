import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from '@poietica/fs-kit'
import { tempDir } from '@poietica/test-kit'
import { mediaAssetUrl } from '../../contract'
import { createMediaAssetHandler } from '../media-handler'

const HAVE = 'c'.repeat(64)
const MISSING = 'd'.repeat(64)

async function make() {
  const root = await tempDir('media-')
  const blobsDir = path.join(root.path, 'blobs')
  await ensureDir(blobsDir)
  fs.writeFileSync(path.join(blobsDir, HAVE), 'PNG')
  return { handler: createMediaAssetHandler({ blobsDir }), root }
}

const request = (sha: string, mime = 'image/png'): Request => new Request(mediaAssetUrl(sha, mime))

describe('时间线图片的资源协议（media/<sha256>）', () => {
  test('blob 目录里有这份字节 → 200，按白名单回 Content-Type', async () => {
    const { handler, root } = await make()
    const res = await handler([HAVE], request(HAVE))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(await res.text()).toBe('PNG')
    await root.dispose()
  })

  test('不是 64 位小写十六进制 / 段数不对 → 400（拼不出 blob 目录之外的路径）', async () => {
    const { handler, root } = await make()
    expect((await handler(['..'], request(HAVE))).status).toBe(400)
    expect((await handler([HAVE.toUpperCase()], request(HAVE))).status).toBe(400)
    expect((await handler([HAVE, 'x'], request(HAVE))).status).toBe(400)
    await root.dispose()
  })

  test('合法 sha 但没有文件 → 404', async () => {
    const { handler, root } = await make()
    expect((await handler([MISSING], request(MISSING))).status).toBe(404)
    await root.dispose()
  })

  test('白名单外的类型（svg、html）→ octet-stream，不会被当文档执行', async () => {
    const { handler, root } = await make()
    for (const mime of ['image/svg+xml', 'text/html']) {
      const res = await handler([HAVE], request(HAVE, mime))
      expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    }
    await root.dispose()
  })
})
