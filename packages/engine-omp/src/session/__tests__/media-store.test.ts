import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { hashMediaRef, sha256Hex } from '../../projector/media'
import { blobMediaRef } from '../media-store'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function blobsDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'poietica-media-'))
  made.push(root)
  return path.join(root, 'blobs')
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

describe('blobMediaRef：每个发上屏的地址背后都有字节', () => {
  test('地址 = 原始字节的 sha256，字节以它为名落进 blob 目录（目录不存在也行）', () => {
    const dir = blobsDir()
    const sha = blobMediaRef(dir)({ data: PNG.toString('base64') })
    expect(sha).toBe(sha256Hex(PNG))
    expect(readFileSync(path.join(dir, sha))).toEqual(PNG)
  })

  test('与纯函数版算出的地址一致（单测用 hashMediaRef 不会和生产对不上号）', () => {
    const image = { data: PNG.toString('base64') }
    expect(blobMediaRef(blobsDir())(image)).toBe(hashMediaRef(image))
  })

  test('同一个图片块对象只落一次盘：第二次直接用记住的地址（文件被删也不重写）', () => {
    const dir = blobsDir()
    const ref = blobMediaRef(dir)
    const block = { data: PNG.toString('base64') }
    const sha = ref(block)
    rmSync(path.join(dir, sha))
    expect(ref(block)).toBe(sha)
    expect(() => statSync(path.join(dir, sha))).toThrow()
    /* 换一个对象（例如会话重读之后）会重新确认，字节补回来 */
    expect(ref({ data: block.data })).toBe(sha)
    expect(statSync(path.join(dir, sha)).size).toBe(PNG.length)
  })
})
