import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { captureBefore, changesOf, readText, writePathsOf } from '../file-changes'

/*
 * 撤销一轮的改动全靠这份前后正文：写完之后工作区里只剩新内容，
 * 所以「读旧的那一份」必须发生在工具动手之前，且读不准的（二进制、太大）宁可记不下来。
 */

const made: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'poietica-file-changes-'))
  made.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('认哪一次调用在写文件', () => {
  test('会写文件的工具：path / file_path / paths 三种写法都认', () => {
    expect(writePathsOf('write', { path: 'a.ts' })).toEqual(['a.ts'])
    expect(writePathsOf('edit', { file_path: 'b.ts' })).toEqual(['b.ts'])
    expect(writePathsOf('ast_edit', { paths: ['c.ts', 'd.ts'] })).toEqual(['c.ts', 'd.ts'])
  })

  test('不写文件的工具一律不认：读、跑命令、搜索都不是改动', () => {
    expect(writePathsOf('read', { path: 'a.ts' })).toEqual([])
    expect(writePathsOf('bash', { command: 'rm -rf /' })).toEqual([])
  })
})

describe('读一份正文', () => {
  test('文件存在：读到原内容', async () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, 'a.ts'), 'one\n')

    expect(await readText(path.join(dir, 'a.ts'))).toBe('one\n')
  })

  test('文件不存在交 undefined：那是「本来就没有」，撤销时该删掉它', async () => {
    const dir = tempDir()

    expect(await readText(path.join(dir, 'missing.ts'))).toBeUndefined()
  })

  test('二进制交 null：拿一份读不准的 before 去撤销，会把文件写成别的东西', async () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]))

    expect(await readText(path.join(dir, 'blob.bin'))).toBeNull()
  })
})

describe('开工前抄下的正文', () => {
  test('在的抄到内容，不在的是 undefined，读不准的不进表', async () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, 'a.ts'), 'one\n')
    writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0x00]))

    const held = await captureBefore(dir, ['a.ts', 'missing.ts', 'blob.bin'])

    expect(held.get(path.join(dir, 'a.ts'))).toBe('one\n')
    expect(held.get(path.join(dir, 'missing.ts'))).toBeUndefined()
    expect(held.has(path.join(dir, 'missing.ts'))).toBe(true)
    expect(held.has(path.join(dir, 'blob.bin'))).toBe(false)
  })
})

describe('收尾时算这一回写了什么', () => {
  test('产出 details 自报的前后正文优先：它带着写之前的原文', async () => {
    const dir = tempDir()
    const changes = await changesOf(
      dir,
      'edit',
      { details: { path: 'a.ts', oldText: 'old\n', newText: 'new\n' }, isError: false },
      new Map(),
    )

    expect(changes).toEqual([{ path: path.join(dir, 'a.ts'), before: 'old\n', after: 'new\n' }])
  })

  test('details 是 perFileResults 时逐个认（一次编辑改了好几个文件）', async () => {
    const dir = tempDir()
    const changes = await changesOf(
      dir,
      'edit',
      {
        details: {
          perFileResults: [
            { path: 'a.ts', oldText: 'a1', newText: 'a2' },
            { path: 'b.ts', oldText: 'b1', newText: 'b2' },
          ],
        },
        isError: false,
      },
      new Map(),
    )

    expect(changes.map((c) => path.basename(c.path))).toEqual(['a.ts', 'b.ts'])
    expect(changes[1]).toEqual({ path: path.join(dir, 'b.ts'), before: 'b1', after: 'b2' })
  })

  test('新建文件：details 没有 oldText，before 记 null（撤销就是删掉它）', async () => {
    const dir = tempDir()
    const changes = await changesOf(
      dir,
      'write',
      { details: { path: 'new.ts', newText: 'hello' }, isError: false },
      new Map(),
    )

    expect(changes).toEqual([{ path: path.join(dir, 'new.ts'), before: null, after: 'hello' }])
  })

  test('删除文件：details 没有 newText，after 记 null（撤销就是写回 before）', async () => {
    const dir = tempDir()
    const changes = await changesOf(
      dir,
      'edit',
      { details: { path: 'gone.ts', oldText: 'bye' }, isError: false },
      new Map(),
    )

    expect(changes).toEqual([{ path: path.join(dir, 'gone.ts'), before: 'bye', after: null }])
  })

  test('写进去的内容与原来一样：不算一次改动，屏幕上也不该多一条「已更改」', async () => {
    const dir = tempDir()
    const changes = await changesOf(
      dir,
      'write',
      { details: { path: 'a.ts', oldText: 'same\n', newText: 'same\n' }, isError: false },
      new Map(),
    )

    expect(changes).toEqual([])
  })

  test('工具报错：这一回什么都没写成，一处改动都不记', async () => {
    const dir = tempDir()
    const changes = await changesOf(
      dir,
      'write',
      { details: { path: 'a.ts', oldText: null, newText: 'x' }, isError: true },
      new Map(),
    )

    expect(changes).toEqual([])
  })

  test('details 没报：拿盘上现在的内容当 after，before 是开工前抄下的那一份', async () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, 'a.ts'), 'after\n')

    const changes = await changesOf(dir, 'write', { isError: false }, new Map([[path.join(dir, 'a.ts'), 'before\n']]))

    expect(changes).toEqual([{ path: path.join(dir, 'a.ts'), before: 'before\n', after: 'after\n' }])
  })

  test('details 没报且盘上是二进制：这一处不记 —— 宁可撤销时少一个文件，也不把它写坏', async () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0x00, 0x01]))

    const changes = await changesOf(
      dir,
      'write',
      { details: { path: 'blob.bin' }, isError: false },
      new Map([[path.join(dir, 'blob.bin'), 'x']]),
    )

    expect(changes).toEqual([])
  })
})
