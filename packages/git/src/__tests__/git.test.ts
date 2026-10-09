import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run } from '@poietica/process-kit'
import { GitCommandError, GitNotFoundError, GitRefusedError, NotARepositoryError } from '../errors'
import { assertSafeRefName, createGit } from '../git'

let root = ''
const made: string[] = []

async function tempRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'poietica-git-'))
  made.push(dir)
  await run('git', ['init', '--initial-branch=trunk'], { cwd: dir })
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir })
  await run('git', ['commit', '--allow-empty', '-m', 'root'], { cwd: dir })
  return dir
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

describe('createGit', () => {
  test('status() 读出分支且没有条目', async () => {
    root = await tempRepo()
    const status = await createGit({ cwd: root }).status()
    expect(status?.head).toBe('trunk')
    expect(status?.entries).toEqual([])
  })

  test('新文件是一个 untracked 条目', async () => {
    root = await tempRepo()
    writeFileSync(path.join(root, '新文件.txt'), 'hi')
    const git = createGit({ cwd: root })
    const status = await git.status()
    const { unstaged } = { unstaged: status?.entries.filter((e) => e.kind === 'untracked') ?? [] }
    expect(unstaged.length).toBe(1)
    expect(stagedNames(status)).toEqual([])
  })

  test('非仓库目录：status() 返回 null，run() 抛 NotARepositoryError', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'poietica-norepo-'))
    made.push(dir)
    const git = createGit({ cwd: dir })
    expect(await git.status()).toBeNull()
    await expect(git.run(['log'])).rejects.toBeInstanceOf(NotARepositoryError)
  })

  test('未知子命令抛 GitCommandError 且 reason 为 exit', async () => {
    root = await tempRepo()
    const error = await createGit({ cwd: root })
      .run(['bogus-cmd'])
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GitCommandError)
    expect((error as GitCommandError).reason).toBe('exit')
  })

  test('不存在的 git 可执行文件 → GitNotFoundError', async () => {
    root = await tempRepo()
    await expect(createGit({ cwd: root, gitPath: 'C:\\nope\\git.exe' }).run(['status'])).rejects.toBeInstanceOf(
      GitNotFoundError,
    )
  })

  test('branches() 含 trunk 且 isCurrent 为真', async () => {
    root = await tempRepo()
    const branches = await createGit({ cwd: root }).branches()
    const trunk = branches.find((b) => b.name === 'trunk')
    expect(trunk?.isCurrent).toBe(true)
  })
})

describe('assertSafeRefName', () => {
  test('以 - 开头或空白 → GitRefusedError；正常名字通过', () => {
    expect(() => assertSafeRefName('分支名', '-x')).toThrow(GitRefusedError)
    expect(() => assertSafeRefName('分支名', '   ')).toThrow(GitRefusedError)
    expect(() => assertSafeRefName('分支名', 'feature/one')).not.toThrow()
  })
})

function stagedNames(status: { entries: readonly { kind: string }[] } | null): string[] {
  return status?.entries.filter((e) => e.kind === 'ignored').map((e) => e.kind) ?? []
}
