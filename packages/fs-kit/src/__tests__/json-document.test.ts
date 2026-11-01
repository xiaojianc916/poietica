import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test'
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

  /*
   * 以前 save() 的 Promise 就是那条吞掉失败的链：写盘失败也 resolve，prefs-service「写盘失败时不广播、错误返回 UI」
   * 那条顺序因此从来没生效过 —— 界面显示已保存，重启后设置回到旧值。
   */
  test('save 写盘失败 → reject，current() 退回上一份；链不被这次失败卡住', async () => {
    const blocker = path.join(dir, 'blocker')
    const doc = createJsonDocument({
      file: path.join(blocker, 'doc.json'),
      schema,
      defaults: () => ({ a: 0, b: 'default' }),
      logger: noopLogger,
    })
    await doc.load()
    /* 目录的位置被一个普通文件占住：mkdir / open 必然失败 */
    await writeFile(blocker, 'not a directory')
    await expect(doc.save({ a: 1, b: 'one' })).rejects.toBeDefined()
    expect(doc.current()).toEqual({ a: 0, b: 'default' })

    await rm(blocker)
    await doc.save({ a: 2, b: 'two' })
    expect(JSON.parse(await readFile(path.join(blocker, 'doc.json'), 'utf8'))).toEqual({ a: 2, b: 'two' })
    expect(doc.current()).toEqual({ a: 2, b: 'two' })
  })

  test('flush 在写盘失败时不 reject（退出路径上逐个 flush）', async () => {
    const blocker = path.join(dir, 'blocker')
    const doc = createJsonDocument({
      file: path.join(blocker, 'doc.json'),
      schema,
      defaults: () => ({ a: 0, b: 'default' }),
      logger: noopLogger,
      debounceMs: 10_000,
    })
    await doc.load()
    await writeFile(blocker, 'not a directory')
    doc.saveDebounced({ a: 3, b: 'three' })
    await expect(doc.flush()).resolves.toBeUndefined()
  })

  test('saveDebounced 连续 3 次只落盘最后一次', async () => {
    const doc = makeDocument({ debounceMs: 20 })
    await doc.load()
    /*
     * 时间用假钟推进、用代码自己暴露的 flush() 收口，不赌真实磁盘速度：去抖窗口到点后
     * 那次写入是异步的（临时文件 → fsync → 改名），CI 冷盘上可能远超任何固定 sleep
     * （老写法赌 Bun.sleep(50)，偶发还没落盘就断言 → ENOENT 假红）。
     */
    vi.useFakeTimers()
    try {
      doc.saveDebounced({ a: 1, b: 'one' })
      doc.saveDebounced({ a: 2, b: 'two' })
      doc.saveDebounced({ a: 3, b: 'three' })
      vi.advanceTimersByTime(30) // 去抖窗口到点：只有最后一次进入写入
    } finally {
      vi.useRealTimers()
    }
    await doc.flush()
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
