import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run, which } from '@poietica/process-kit'
import { applyPatch, createWorktree, listWorktrees, removeWorktree, worktreeDiff } from '../index'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'poietica-worktree-'))
  roots.push(root)
  const git = await which('git')
  if (git === null) throw new Error('测试需要 git')
  const dir = path.join(root, 'repo')
  await run(git, ['init', '--quiet', dir], { cwd: root })
  await run(git, ['config', 'user.name', 'test'], { cwd: dir })
  await run(git, ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await writeFile(path.join(dir, 'a.txt'), 'one')
  await run(git, ['add', '-A'], { cwd: dir })
  await run(git, ['commit', '-m', 'init'], { cwd: dir })
  return dir
}

describe('隔离 worktree', () => {
  test('创建、列点、生成补丁并应用到主工作区', async () => {
    const main = await repo()
    const wt = path.join(path.dirname(main), 'wt')
    const created = await createWorktree({ repoPath: main, path: wt, branch: 'poietica/thread-1' })
    expect(created).toMatchObject({ path: wt, branch: 'poietica/thread-1', base: 'HEAD' })

    const entries = await listWorktrees(main)
    expect(entries.some((entry) => entry.branch === 'poietica/thread-1')).toBe(true)

    await writeFile(path.join(wt, 'b.txt'), 'two')
    const patch = await worktreeDiff({ path: wt, base: 'HEAD' })
    expect(patch).toContain('b.txt')
    expect(patch).toContain('+two')

    expect(await applyPatch({ repoPath: main, patch })).toEqual({ applied: true })
    expect(await readFile(path.join(main, 'b.txt'), 'utf8')).toBe('two')

    await removeWorktree({ repoPath: main, path: wt, branch: 'poietica/thread-1' })
    expect((await listWorktrees(main)).some((entry) => entry.branch === 'poietica/thread-1')).toBe(false)
  })
})
