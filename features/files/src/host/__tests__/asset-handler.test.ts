import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '@poietica/foundation'
import { type TempDir, tempDir } from '@poietica/test-kit'
import type { LocatedFile } from '../../contract'
import { createWorkspaceFileAssetHandler } from '../asset-handler'

const request = new Request('poietica-asset://workspace-file/x')

describe('工作区图片的资源协议', () => {
  let dir: TempDir
  let errors: unknown[]

  beforeEach(async () => {
    dir = await tempDir('poietica-files-asset-')
    errors = []
    await writeFile(path.join(dir.path, 'logo.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    await writeFile(path.join(dir.path, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  })

  afterEach(async () => {
    await dir.dispose()
  })

  const handlerWith = (locate: (workspaceId: string, relative: string) => Promise<LocatedFile>) =>
    createWorkspaceFileAssetHandler({
      locate,
      onError: (cause) => {
        errors.push(cause)
      },
    })

  const located = (relative: string, kind: LocatedFile['kind'] = 'file'): Promise<LocatedFile> =>
    Promise.resolve({ path: relative, absolutePath: path.join(dir.path, relative), kind })

  test('图片：经 locate 解析后发字节，带类型、不缓存', async () => {
    const seen: string[] = []
    const handler = handlerWith((workspaceId, relative) => {
      seen.push(`${workspaceId}:${relative}`)
      return located(relative)
    })
    const response = await handler(['w1', 'logo.png'], request)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Cache-Control')).toBe('no-cache')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    expect(seen).toEqual(['w1:logo.png'])
  })

  test('SVG 带 CSP sandbox：直接导航过去也不执行脚本', async () => {
    const response = await handlerWith((_w, relative) => located(relative))(['w1', 'icon.svg'], request)
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox')
  })

  test('不是图片：415，连 locate 都不问（不是一条读任意文件的旁路）', async () => {
    let asked = false
    const response = await handlerWith((_w, relative) => {
      asked = true
      return located(relative)
    })(['w1', 'secret.env'], request)
    expect(response.status).toBe(415)
    expect(asked).toBe(false)
  })

  test('缺段 400；越界 403；不存在 / 工作区没了 / 是目录 404；其余 500 并上报', async () => {
    const reject = (code: string) => () => Promise.reject(new AppError(code, code))
    expect((await handlerWith(reject('files.not_found'))(['w1'], request)).status).toBe(400)
    expect((await handlerWith(reject('files.outside_workspace'))(['w1', 'a.png'], request)).status).toBe(403)
    expect((await handlerWith(reject('files.not_found'))(['w1', 'a.png'], request)).status).toBe(404)
    expect((await handlerWith(reject('workspaces.not_found'))(['w1', 'a.png'], request)).status).toBe(404)
    expect((await handlerWith((_w, relative) => located(relative, 'directory'))(['w1', 'a.png'], request)).status).toBe(
      404,
    )
    expect(errors).toEqual([])
    expect((await handlerWith(reject('internal'))(['w1', 'a.png'], request)).status).toBe(500)
    expect(errors).toHaveLength(1)
  })
})
