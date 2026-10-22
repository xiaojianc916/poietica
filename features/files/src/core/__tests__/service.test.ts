import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type TempDir, tempDir } from '@poietica/test-kit'
import { createFilesService, type FilesGit, LIST_LIMIT, matchPaths, TEXT_LIMIT } from '../service'

function fakeGit(o: { ignored?: readonly string[]; files?: readonly string[] | null } = {}) {
  const calls = { files: 0 }
  const git: FilesGit = {
    ignored: async (_root, candidates) => new Set(candidates.filter((c) => o.ignored?.includes(c) === true)),
    files: async () => {
      calls.files += 1
      return o.files === undefined ? null : o.files
    },
  }
  return { git, calls }
}

describe('matchPaths', () => {
  const files = ['src/review/review-pane.tsx', 'docs/review-notes.md', 'src/a/b/c/review-pane-extra/x.ts', 'README.md']

  test('几段都要命中，不分大小写；名字命中排在路径命中前面，再按长短', () => {
    expect(matchPaths(files, 'REVIEW pane', 10).hits).toEqual([
      'src/review/review-pane.tsx',
      'src/a/b/c/review-pane-extra/x.ts',
    ])
    expect(matchPaths(files, 'review', 10).hits[0]).toBe('docs/review-notes.md')
  })

  test('空查询不命中；超出上限 truncated', () => {
    expect(matchPaths(files, '   ', 10)).toEqual({ hits: [], truncated: false })
    expect(matchPaths(files, 'r', 2)).toEqual({ hits: expect.any(Array), truncated: true })
    expect(matchPaths(files, 'r', 2).hits).toHaveLength(2)
  })
})

describe('createFilesService', () => {
  let dir: TempDir
  let root: string

  beforeEach(async () => {
    dir = await tempDir('poietica-files-')
    root = dir.path
    await mkdir(path.join(root, 'src'), { recursive: true })
    await mkdir(path.join(root, '.git'), { recursive: true })
    await mkdir(path.join(root, 'dist'), { recursive: true })
    await writeFile(path.join(root, 'b.ts'), 'export const b = 1\n')
    await writeFile(path.join(root, 'A.md'), '# A\n')
    await writeFile(path.join(root, 'src', 'a.ts'), 'export {}\n')
  })

  afterEach(async () => {
    await dir.dispose()
  })

  test('list：目录在前、按名排序；.git 不列；被忽略的标出来（目录带尾斜杠去问）', async () => {
    const { git } = fakeGit({ ignored: ['dist/'] })
    const listing = await createFilesService({ git }).list(root, '')
    expect(listing.truncated).toBe(false)
    expect(listing.entries.map((entry) => [entry.path, entry.kind, entry.ignored])).toEqual([
      ['dist', 'directory', true],
      ['src', 'directory', false],
      ['A.md', 'file', false],
      ['b.ts', 'file', false],
    ])
    const nested = await createFilesService({ git }).list(root, 'src')
    expect(nested.entries.map((entry) => entry.path)).toEqual(['src/a.ts'])
  })

  test('list 一个文件：not_a_directory；越界：outside_workspace', async () => {
    const service = createFilesService({ git: fakeGit().git })
    expect(await service.list(root, 'b.ts').catch((cause: { code: string }) => cause.code)).toBe(
      'files.not_a_directory',
    )
    expect(await service.list(root, '..').catch((cause: { code: string }) => cause.code)).toBe(
      'files.outside_workspace',
    )
  })

  test('list 超过上限：截断并明说', async () => {
    await mkdir(path.join(root, 'many'))
    await Promise.all(
      Array.from({ length: LIST_LIMIT + 5 }, (_, index) => writeFile(path.join(root, 'many', `f${String(index)}`), '')),
    )
    const listing = await createFilesService({ git: fakeGit().git }).list(root, 'many')
    expect(listing.truncated).toBe(true)
    expect(listing.entries).toHaveLength(LIST_LIMIT)
  })

  test('read：正文 / 图片（只给元数据）/ 二进制 / 目录', async () => {
    await writeFile(path.join(root, 'logo.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))
    await writeFile(path.join(root, 'blob.bin'), new Uint8Array([1, 2, 0, 3]))
    const service = createFilesService({ git: fakeGit().git })
    const text = await service.read(root, 'src/a.ts')
    expect(text).toMatchObject({
      kind: 'text',
      path: 'src/a.ts',
      text: 'export {}\n',
      encoding: 'utf-8',
      truncated: false,
    })
    expect(await service.read(root, 'logo.png')).toMatchObject({ kind: 'image', mime: 'image/png', size: 6 })
    expect(await service.read(root, 'blob.bin')).toMatchObject({ kind: 'binary', size: 4 })
    expect(await service.read(root, 'src').catch((cause: { code: string }) => cause.code)).toBe('files.is_directory')
  })

  test('read 超过上限：只读开头一段并标 truncated', async () => {
    const line = `${'x'.repeat(99)}\n`
    await writeFile(path.join(root, 'big.log'), line.repeat(Math.ceil(TEXT_LIMIT / line.length) + 10))
    const content = await createFilesService({ git: fakeGit().git }).read(root, 'big.log')
    expect(content.kind).toBe('text')
    if (content.kind !== 'text') return
    expect(content.truncated).toBe(true)
    expect(content.text.length).toBeLessThanOrEqual(TEXT_LIMIT)
    expect(content.text.endsWith('\n')).toBe(true)
  })

  test('locate：交回相对与绝对路径、是文件还是目录', async () => {
    const service = createFilesService({ git: fakeGit().git })
    expect(await service.locate(root, path.join(root, 'src', 'a.ts'))).toEqual({
      path: 'src/a.ts',
      absolutePath: path.join(root, 'src', 'a.ts'),
      kind: 'file',
    })
    expect((await service.locate(root, 'src')).kind).toBe('directory')
  })

  test('search：仓库里用 git 的清单（尊重 .gitignore）并缓存；invalidate 后重取', async () => {
    const { git, calls } = fakeGit({ files: ['src/a.ts', 'b.ts'] })
    const service = createFilesService({ git })
    expect((await service.search(root, 'a.ts')).hits).toEqual([{ path: 'src/a.ts' }])
    await service.search(root, 'b')
    expect(calls.files).toBe(1)
    service.invalidate(root)
    await service.search(root, 'b')
    expect(calls.files).toBe(2)
  })

  test('search：不是仓库时自己遍历（跳过 .git）；清单过期后重取', async () => {
    let clock = 0
    const { git, calls } = fakeGit({ files: null })
    const service = createFilesService({ git, now: () => clock })
    expect((await service.search(root, 'a')).hits.map((hit) => hit.path).sort()).toEqual(['A.md', 'src/a.ts'])
    clock = 60_000
    await service.search(root, 'a')
    expect(calls.files).toBe(2)
  })
})
