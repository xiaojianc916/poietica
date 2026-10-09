import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { renameWithRetry, writeFileAtomic } from '../atomic'

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

/*
 * R-08-12：Windows 上目标文件被 Defender / 索引器短暂打开时，rename 会抛
 * EPERM / EACCES / EBUSY —— 从前直接失败，这次写入丢失（JsonDocument 只记 error）。
 * 现在对这三个码退避重试（10→20→40…，总上限 2 秒），其它错误立刻抛出。
 */
describe('renameWithRetry（R-08-12）', () => {
  const winError = (code: string): Error => Object.assign(new Error(`${code} 模拟拒绝`), { code })

  test('前两次 EPERM、第三次成功 → 写入成功且不重试第四次', async () => {
    let calls = 0
    await renameWithRetry(
      async () => {
        calls += 1
        if (calls <= 2) throw winError('EPERM')
      },
      'from',
      'to',
      { sleep: async () => undefined },
    )
    expect(calls).toBe(3)
  })

  test('EACCES / EBUSY 同样重试；其它错误码立刻抛出（不白等）', async () => {
    let busy = 0
    await renameWithRetry(
      async () => {
        busy += 1
        if (busy <= 1) throw winError('EBUSY')
      },
      'from',
      'to',
      { sleep: async () => undefined },
    )
    expect(busy).toBe(2)

    let enoent = 0
    const err = await renameWithRetry(
      async () => {
        enoent += 1
        throw winError('ENOENT')
      },
      'from',
      'to',
      { sleep: async () => undefined },
    ).catch((e: unknown) => e)
    expect((err as Error).message).toContain('ENOENT')
    expect(enoent).toBe(1)
  })

  test('一直拒绝时，总等待封顶后把最后一个错误抛出（不会无限重试）', async () => {
    let calls = 0
    const err = await renameWithRetry(
      async () => {
        calls += 1
        throw winError('EPERM')
      },
      'from',
      'to',
      { sleep: async () => undefined },
    ).catch((e: unknown) => e)
    expect((err as Error).message).toContain('EPERM')
    expect(calls).toBeGreaterThan(1)
  })

  test('writeFileAtomic 走重试路径：rename 前两次 EPERM 也能写成，且临时文件不残留', async () => {
    const file = path.join(dir, 'retry.txt')
    let calls = 0
    await writeFileAtomic(file, 'retried', {
      rename: async (from, to) => {
        calls += 1
        if (calls <= 2) throw winError('EPERM')
        await rename(from, to)
      },
      sleep: async () => undefined,
    })
    expect(calls).toBe(3)
    expect(await readFile(file, 'utf8')).toBe('retried')
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
