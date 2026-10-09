import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { noopLogger } from '@poietica/foundation'
import { z } from 'zod'
import { createJsonDocument, type JsonDocument } from '../json-document'

const schema = z.object({ a: z.number().default(1), b: z.string().default('x') })
type Value = z.infer<typeof schema>

let dir: string
let file: string

const makeDocument = (o: { debounceMs?: number } = {}): JsonDocument<Value> =>
  createJsonDocument({
    file,
    schema,
    defaults: () => ({ a: 0, b: 'default' }),
    logger: noopLogger,
    ...o,
  })

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'fs-kit-'))
  file = path.join(dir, 'doc.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('createJsonDocument', () => {
  test('文件不存在时 load() 返回 defaults', async () => {
    const doc = makeDocument()
    expect(await doc.load()).toEqual({ a: 0, b: 'default' })
  })

  test('坏 JSON 返回 defaults，原文件被改名为 *.corrupt-<数字>', async () => {
    await writeFile(file, '{ not json')
    const doc = makeDocument()
    expect(await doc.load()).toEqual({ a: 0, b: 'default' })
    expect((await readdir(dir)).filter((name) => /^doc\.json\.corrupt-\d+$/.test(name))).toHaveLength(1)
  })

  test('schema 新增带 .default() 的字段：旧文件缺该字段时补默认值', async () => {
    await writeFile(file, JSON.stringify({ a: 5 }))
    const doc = makeDocument()
    expect(await doc.load()).toEqual({ a: 5, b: 'x' })
  })

  test('saveDebounced 连续 3 次只落盘最后一次', async () => {
    const doc = makeDocument({ debounceMs: 20 })
    await doc.load()
    doc.saveDebounced({ a: 1, b: 'one' })
    doc.saveDebounced({ a: 2, b: 'two' })
    doc.saveDebounced({ a: 3, b: 'three' })
    await Bun.sleep(50)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ a: 3, b: 'three' })
  })

  test('flush() 立即落盘待写内容', async () => {
    const doc = makeDocument({ debounceMs: 60_000 })
    await doc.load()
    doc.saveDebounced({ a: 9, b: 'nine' })
    await doc.flush()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ a: 9, b: 'nine' })
  })

  test('current() 在 load() 之前抛错', async () => {
    const doc = makeDocument()
    expect(() => doc.current()).toThrow('JsonDocument 未加载')
  })
})
