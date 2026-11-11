import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '@poietica/foundation'
import { assertSafeRefName, createGit } from '@poietica/git'

export interface Worktree {
  readonly path: string
  readonly branch: string
  readonly base: string
}

export interface CreateWorktreeOptions {
  readonly repoPath: string
  readonly path: string
  readonly branch: string
  /** 默认 HEAD */
  readonly base?: string
}

/** 在用户仓库里建一个隔离 worktree（§14.1 / §14.5）。路径由调用方放在应用数据目录。 */
export async function createWorktree(o: CreateWorktreeOptions): Promise<Worktree> {
  assertSafeRefName('分支名', o.branch)
  const base = o.base ?? 'HEAD'
  if (base !== 'HEAD') assertSafeRefName('基线引用', base)
  if (!path.isAbsolute(o.path)) throw new AppError('worktree.invalid_path', `worktree 路径必须是绝对路径：${o.path}`)
  const git = createGit({ cwd: o.repoPath })
  await mkdir(path.dirname(o.path), { recursive: true })
  await git.run(['worktree', 'add', '-b', o.branch, o.path, base])
  return { path: o.path, branch: o.branch, base }
}

/** 删除 worktree 目录与它在主仓库里的登记；可选删掉分支。 */
export async function removeWorktree(input: {
  readonly repoPath: string
  readonly path: string
  readonly branch?: string
}): Promise<void> {
  const git = createGit({ cwd: input.repoPath })
  await git.run(['worktree', 'remove', '--force', input.path])
  await git.run(['worktree', 'prune'])
  if (input.branch !== undefined) {
    assertSafeRefName('分支名', input.branch)
    await git.run(['branch', '-D', input.branch], { okExitCodes: [0, 1] })
  }
}

export interface WorktreeEntry {
  readonly path: string
  readonly head: string
  readonly branch: string | null
  readonly detached: boolean
}

export async function listWorktrees(repoPath: string): Promise<readonly WorktreeEntry[]> {
  const result = await createGit({ cwd: repoPath }).run(['worktree', 'list', '--porcelain'])
  return result.stdout
    .split(/\r?\n\r?\n/)
    .map((block) => parseWorktree(block))
    .filter((entry): entry is WorktreeEntry => entry !== null)
}

/**
 * worktree 相对基线的完整补丁（含未跟踪文件：先 `add -A` 再 diff）。
 * 只改这个 worktree 的索引，不提交、不动用户仓库的分支。
 */
export async function worktreeDiff(input: { readonly path: string; readonly base: string }): Promise<string> {
  assertSafeRefName('基线引用', input.base)
  const git = createGit({ cwd: input.path })
  await git.run(['add', '-A'])
  return (await git.run(['diff', '--no-color', '--binary', input.base], { timeoutMs: 120_000 })).stdout
}

/** 把 worktree 相对基线的补丁应用到主工作区；冲突返回失败原因，不抛。 */
export async function applyPatch(input: {
  readonly repoPath: string
  readonly patch: string
}): Promise<{ readonly applied: true } | { readonly applied: false; readonly reason: string }> {
  const git = createGit({ cwd: input.repoPath })
  try {
    await git.run(['apply', '--3way', '--binary', '-'], { input: input.patch, timeoutMs: 120_000 })
    return { applied: true }
  } catch (error) {
    return { applied: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function parseWorktree(block: string): WorktreeEntry | null {
  if (!block.includes('worktree ')) return null
  let worktreePath = ''
  let head = ''
  let branch: string | null = null
  let detached = false
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) worktreePath = line.slice('worktree '.length)
    else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
    else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    else if (line === 'detached') detached = true
  }
  return worktreePath === '' ? null : { path: worktreePath, head, branch, detached }
}
