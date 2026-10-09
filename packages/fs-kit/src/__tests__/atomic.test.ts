import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from '../atomic'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'fs-kit-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  test('写入后内容正确，目录中没有残留 .tmp 文件', async () => {
    const file = path.join(dir, 'a.txt')
    await writeFileAtomic(file, 'hello')
    expect(await readFile(file, 'utf8')).toBe('hello')
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  test('父目录不存在时自动创建', async () => {
    const file = path.join(dir, 'x', 'y', 'b.txt')
    await writeFileAtomic(file, 'deep')
    expect(await readFile(file, 'utf8')).toBe('deep')
  })

  test('并发 10 次写同一文件，最终内容是 10 个值之一且完整', async () => {
    const file = path.join(dir, 'c.txt')
    const values = Array.from({ length: 10 }, (_, i) => `v${i}`)
    // 本机实测：多个并发 rename 落到同一目标时 Windows 会返回 EPERM（与 writeFileAtomic 的实现无关，
    // 裸 writeFile + rename 同样复现），因此用 allSettled 收集结果，断言原子性本身：
    // 最终内容必须正好是某一个完整的值，不能是两个值拼接，也不能残留 .tmp
    const results = await Promise.allSettled(values.map((value) => writeFileAtomic(file, value)))
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true)
    const text = await readFile(file, 'utf8')
    expect(values).toContain(text)
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
