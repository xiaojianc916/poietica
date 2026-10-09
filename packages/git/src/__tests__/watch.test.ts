import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isNoteworthy, watchRepository } from '../watch'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('isNoteworthy', () => {
  test('源码为真；.git 内只关心 HEAD/index/packed-refs/MERGE_HEAD/refs；node_modules 为假', () => {
    expect(isNoteworthy('src/lib.rs')).toBe(true)
    expect(isNoteworthy('.git/HEAD')).toBe(true)
    expect(isNoteworthy('.git/index')).toBe(true)
    expect(isNoteworthy('.git/refs/heads/main')).toBe(true)
    expect(isNoteworthy('.git/objects/ab/cd')).toBe(false)
    expect(isNoteworthy('.git/index.lock')).toBe(false)
    expect(isNoteworthy('a/node_modules/x')).toBe(false)
    expect(isNoteworthy('.git')).toBe(false)
  })
})

describe('watchRepository', () => {
  test('连续写 5 个文件只通知一次；dispose 后不再通知', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'poietica-watch-'))
    dirs.push(dir)
    let calls = 0
    const sub = watchRepository(
      dir,
      () => {
        calls++
      },
      { debounceMs: 100 },
    )
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `f${i}.txt`), 'x')
      await Bun.sleep(10)
    }
    await Bun.sleep(400)
    expect(calls).toBe(1)
    sub.dispose()
    writeFileSync(path.join(dir, 'after.txt'), 'x')
    await Bun.sleep(300)
    expect(calls).toBe(1)
  })
})
