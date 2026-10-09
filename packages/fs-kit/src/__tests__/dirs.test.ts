import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureDir, removeSafe } from '../dirs'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'fs-kit-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('removeSafe', () => {
  test('删除 within 内的目录树', async () => {
    const within = path.join(dir, 'root')
    const target = path.join(within, 'a', 'b')
    await ensureDir(target)
    await writeFile(path.join(target, 'f.txt'), 'x')
    await removeSafe(target, { within })
    expect(existsSync(target)).toBe(false)
  })

  test('target 在 within 之外时抛错且文件仍在', async () => {
    const within = path.join(dir, 'root')
    await ensureDir(within)
    const outside = path.join(dir, 'outside')
    await ensureDir(outside)
    const file = path.join(outside, 'f.txt')
    await writeFile(file, 'keep')
    await expect(removeSafe(outside, { within })).rejects.toThrow('拒绝删除')
    expect(await readFile(file, 'utf8')).toBe('keep')
  })

  test('target 等于 within 时抛错', async () => {
    const within = path.join(dir, 'root')
    await ensureDir(within)
    await expect(removeSafe(within, { within })).rejects.toThrow('拒绝删除')
    expect(existsSync(within)).toBe(true)
  })

  test('target 不存在时不抛错', async () => {
    const within = path.join(dir, 'root')
    await ensureDir(within)
    await expect(removeSafe(path.join(within, 'nope'), { within })).resolves.toBeUndefined()
  })
})
