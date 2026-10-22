import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type TempDir, tempDir } from '@poietica/test-kit'
import { resolveLexical, resolveReal } from '../paths'

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (cause: unknown) {
    return String((cause as { code?: unknown }).code)
  }
  return 'no error'
}

async function codeOfAsync(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (cause: unknown) {
    return String((cause as { code?: unknown }).code)
  }
  return 'no error'
}

describe('resolveLexical：字面那一道关', () => {
  const root = path.resolve('/workspace/repo')

  test('相对路径按根解析，交回正斜杠的相对路径；空串是根本身', () => {
    expect(resolveLexical(root, 'src/a.ts')).toEqual({ absolute: path.join(root, 'src', 'a.ts'), relative: 'src/a.ts' })
    expect(resolveLexical(root, './src/../b.ts').relative).toBe('b.ts')
    expect(resolveLexical(root, '').relative).toBe('')
    expect(resolveLexical(root, '  ').relative).toBe('')
  })

  test('根之内的绝对路径照收', () => {
    expect(resolveLexical(root, path.join(root, 'docs', 'x.md')).relative).toBe('docs/x.md')
  })

  test('经 .. 逃出、或别处的绝对路径：outside_workspace', () => {
    expect(codeOf(() => resolveLexical(root, '../other/a.ts'))).toBe('files.outside_workspace')
    expect(codeOf(() => resolveLexical(root, path.resolve('/etc/passwd')))).toBe('files.outside_workspace')
    expect(codeOf(() => resolveLexical(root, `${root}-sibling/a.ts`))).toBe('files.outside_workspace')
  })

  test('名字以两个点开头的条目仍在里面', () => {
    expect(resolveLexical(root, '..cache/a.ts').relative).toBe('..cache/a.ts')
  })
})

describe('resolveReal：解开链接之后那一道关', () => {
  let dir: TempDir
  let root: string
  let outside: string

  beforeEach(async () => {
    dir = await tempDir('poietica-files-')
    root = path.join(dir.path, 'repo')
    outside = path.join(dir.path, 'secret')
    await mkdir(path.join(root, 'src'), { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(path.join(root, 'src', 'a.ts'), 'export {}\n')
    await writeFile(path.join(outside, 'key.txt'), 'top secret\n')
  })

  afterEach(async () => {
    await dir.dispose()
  })

  test('普通文件：real 与字面一致', async () => {
    const at = await resolveReal(root, 'src/a.ts')
    expect(at.relative).toBe('src/a.ts')
    expect(at.real).toBe(path.join(root, 'src', 'a.ts'))
  })

  test('指向工作区外的链接：outside_workspace（字面上它在里面）', async () => {
    await symlink(path.join(outside, 'key.txt'), path.join(root, 'leak.txt'))
    await symlink(outside, path.join(root, 'leak-dir'), 'dir')
    expect(await codeOfAsync(() => resolveReal(root, 'leak.txt'))).toBe('files.outside_workspace')
    expect(await codeOfAsync(() => resolveReal(root, 'leak-dir/key.txt'))).toBe('files.outside_workspace')
  })

  test('指向工作区内的链接照常', async () => {
    await symlink(path.join(root, 'src', 'a.ts'), path.join(root, 'alias.ts'))
    const at = await resolveReal(root, 'alias.ts')
    expect(at.relative).toBe('alias.ts')
    expect(at.real).toBe(path.join(root, 'src', 'a.ts'))
  })

  test('不存在：not_found', async () => {
    expect(await codeOfAsync(() => resolveReal(root, 'src/missing.ts'))).toBe('files.not_found')
  })
})
