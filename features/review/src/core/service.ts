import path from 'node:path'
import { AppError, type Logger, mapLimited } from '@poietica/foundation'
import {
  assertSafeRefName,
  type Git,
  GitCommandError,
  GitNotFoundError,
  GitRefusedError,
  parseNameStatus,
  parseNulList,
  parseNumstat,
  toChangeLists,
} from '@poietica/git'
import type { GitStatus, ReviewFile } from '../contract/entities'
import { reviewErrors } from '../contract/errors'

export interface ReviewServiceDeps {
  readonly gitFor: (cwd: string) => Git
  readonly logger: Logger
}

export interface ReviewService {
  status(cwd: string): Promise<GitStatus>
  branches(cwd: string): Promise<{ current: string | null; branches: GitBranchInfo[] }>
  switchBranch(cwd: string, branch: string): Promise<GitStatus>
  createBranch(cwd: string, branch: string, from: string | null): Promise<GitStatus>
  review(cwd: string, base: 'HEAD' | 'index'): Promise<ReviewFile[]>
  filePatch(cwd: string, path: string, base: 'HEAD' | 'index'): Promise<string>
  stage(cwd: string, paths: readonly string[]): Promise<GitStatus>
  unstage(cwd: string, paths: readonly string[]): Promise<GitStatus>
  commit(cwd: string, message: string, stageAll: boolean): Promise<{ commit: string }>
}

export interface GitBranchInfo {
  readonly name: string
  readonly isCurrent: boolean
  readonly upstream: string | null
  readonly lastCommitAt: number | null
}

/** 未跟踪文件逐份读：限住同时打开的句柄数，别一次把整棵新目录放出去。 */
const COUNT_CONCURRENCY = 8

const EMPTY: GitStatus = {
  isRepo: false,
  branch: null,
  detachedAt: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
}

/** 错误码转换只在这里做：GitNotFoundError → review.git_not_found；其余 git 子进程失败 → review.git_failed（data 带 stderr）。 */
async function translate<T>(logger: Logger, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    if (e instanceof AppError) throw e
    if (e instanceof GitNotFoundError) {
      throw new AppError(reviewErrors.git_not_found, '找不到 git，请安装 Git for Windows')
    }
    if (e instanceof GitRefusedError) {
      throw new AppError(reviewErrors.git_failed, e.message, { stderr: e.message })
    }
    if (e instanceof GitCommandError) {
      logger.warn('git command failed', { args: e.args.join(' '), exitCode: e.exitCode })
      throw new AppError(reviewErrors.git_failed, e.message, { stderr: e.stderr })
    }
    logger.warn('git operation failed', { error: String(e) })
    throw new AppError(reviewErrors.git_failed, String(e), { stderr: String(e) })
  }
}

export function createReviewService(d: ReviewServiceDeps): ReviewService {
  const { logger } = d

  const statusOf = async (cwd: string): Promise<GitStatus> => {
    const git = d.gitFor(cwd)
    const porcelain = await git.status()
    if (porcelain === null) return EMPTY
    const lists = toChangeLists(porcelain.entries)
    return {
      isRepo: true,
      branch: porcelain.head,
      detachedAt: porcelain.head === null ? shortOid(porcelain.oid) : null,
      upstream: porcelain.upstream,
      ahead: porcelain.ahead,
      behind: porcelain.behind,
      staged: lists.staged,
      unstaged: lists.unstaged,
    }
  }

  return {
    status: (cwd) => translate(logger, () => statusOf(cwd)),

    branches: (cwd) =>
      translate(logger, async () => {
        const git = d.gitFor(cwd)
        const entries = await git.branches()
        const current = entries.find((b) => b.isCurrent)?.name ?? null
        return {
          current,
          branches: entries.map((b) => ({
            name: b.name,
            isCurrent: b.isCurrent,
            upstream: b.upstream,
            lastCommitAt: b.lastCommitAt,
          })),
        }
      }),

    switchBranch: (cwd, branch) =>
      translate(logger, async () => {
        assertSafeRefName('分支名', branch)
        await d.gitFor(cwd).run(['switch', branch])
        return statusOf(cwd)
      }),

    createBranch: (cwd, branch, from) =>
      translate(logger, async () => {
        assertSafeRefName('分支名', branch)
        const git = d.gitFor(cwd)
        const existing = await git.branches()
        if (existing.some((b) => b.name === branch)) {
          throw new AppError(reviewErrors.branch_exists, `分支已存在：${branch}`)
        }
        await git.run(from === null ? ['switch', '-c', branch] : ['switch', '-c', branch, from])
        return statusOf(cwd)
      }),

    review: (cwd, base) => translate(logger, () => reviewFiles(d.gitFor(cwd), base)),

    filePatch: (cwd, path, base) =>
      translate(logger, async () => {
        const git = d.gitFor(cwd)
        const tracked = await git.run(['ls-files', '--error-unmatch', '--', path], { okExitCodes: [0, 1] })
        if (tracked.exitCode !== 0) {
          /* Windows 的空设备名是 NUL；这个命令有差异时退出码是 1，要视为成功。 */
          const r = await git.run(['diff', '--no-index', '--', 'NUL', path], { okExitCodes: [0, 1] })
          return r.stdout
        }
        const args = base === 'index' ? ['diff', '--cached', 'HEAD', '--', path] : ['diff', base, '--', path]
        const r = await git.run(args)
        return r.stdout
      }),

    stage: (cwd, paths) =>
      translate(logger, async () => {
        if (paths.length === 0) return statusOf(cwd)
        await d.gitFor(cwd).run(['add', '--', ...paths])
        return statusOf(cwd)
      }),

    unstage: (cwd, paths) =>
      translate(logger, async () => {
        if (paths.length === 0) return statusOf(cwd)
        await d.gitFor(cwd).run(['restore', '--staged', '--', ...paths])
        return statusOf(cwd)
      }),

    commit: (cwd, message, stageAll) =>
      translate(logger, async () => {
        const git = d.gitFor(cwd)
        if (stageAll) await git.run(['add', '-A'])
        const staged = await git.run(['diff', '--cached', '--name-only'])
        if (staged.stdout.trim() === '') {
          throw new AppError(reviewErrors.nothing_to_commit, '没有可以提交的内容')
        }
        await git.run(['commit', '-m', message])
        const head = await git.run(['rev-parse', '--short', 'HEAD'])
        return { commit: head.stdout.trim() }
      }),
  }
}

function changeOf(code: string): ReviewFile['change'] {
  switch (code) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return 'modified'
  }
}

function shortOid(oid: string | null): string | null {
  if (oid === null) return null
  return oid.slice(0, 7)
}

async function reviewFiles(git: Git, base: 'HEAD' | 'index'): Promise<ReviewFile[]> {
  const cached = base === 'index'
  const diffArgs = cached ? ['diff', '--cached', 'HEAD'] : ['diff', 'HEAD']
  const [numstat, nameStatus] = await Promise.all([
    git.run([...diffArgs, '--numstat', '-z']),
    git.run([...diffArgs, '--name-status', '-z']),
  ])
  const numbers = new Map(parseNumstat(numstat.stdout).map((n) => [n.path, n] as const))
  const files: ReviewFile[] = []
  const seen = new Set<string>()
  for (const s of parseNameStatus(nameStatus.stdout)) {
    const n = numbers.get(s.path)
    seen.add(s.path)
    files.push({
      path: s.path,
      oldPath: s.oldPath,
      change: changeOf(s.status),
      additions: n?.additions ?? 0,
      deletions: n?.deletions ?? 0,
      binary: n?.binary ?? false,
    })
  }
  for (const [path, n] of numbers) {
    if (seen.has(path)) continue
    files.push({
      path,
      oldPath: n.oldPath,
      change: 'modified',
      additions: n.additions ?? 0,
      deletions: n.deletions ?? 0,
      binary: n.binary,
    })
  }
  if (cached) return files
  const others = await git.run(['ls-files', '--others', '--exclude-standard', '-z'])
  /* 每个未跟踪文件各自读、互不依赖；有界并发，结果按 git 给出的顺序收回。 */
  const untracked = await mapLimited(parseNulList(others.stdout), COUNT_CONCURRENCY, async (relative) => ({
    relative,
    counted: await countLines(git.cwd, relative),
  }))
  for (const { relative, counted } of untracked) {
    files.push({ path: relative, oldPath: null, change: 'untracked', ...counted })
  }
  return files
}

/** 未跟踪文件的行数按文件自身算。二进制（含无效 UTF-8）读不出「行」，按 diff 的同一约定记 binary: true、行数 0 —— 让屏幕上
 * 的 +0 −0 与「这一份不是文本」区分开。读失败不炸整次 review。
 * **流式**：以前整文件 `bytes()` + `split('\n')`，工作区里留一个几百 MB 的未跟踪产物就能把 Core 撑爆（OOM 后按 crash_loop
 * 放弃重启）。现在按块数换行、按块做 fatal 解码判定 UTF-8，内存只与块大小有关。 */
async function countLines(
  cwd: string,
  relative: string,
): Promise<Pick<ReviewFile, 'additions' | 'deletions' | 'binary'>> {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let newlines = 0
    let size = 0
    let lastByte = -1
    for await (const chunk of Bun.file(path.join(cwd, relative)).stream()) {
      if (chunk.includes(0)) return { additions: 0, deletions: 0, binary: true }
      /* 合法 UTF-8 的多字节序列里不会出现 0x0A，所以按字节数换行与按字符数换行等价。 */
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) newlines += 1
      size += chunk.length
      if (chunk.length > 0) lastByte = chunk[chunk.length - 1]!
      /* 只用来在流式里发现非法序列：fatal 解码器遇到坏字节会抛，落到下面的 binary 分支。输出不保留。 */
      decoder.decode(chunk, { stream: true })
    }
    decoder.decode()
    if (size === 0) return { additions: 0, deletions: 0, binary: false }
    return { additions: lastByte === 0x0a ? newlines : newlines + 1, deletions: 0, binary: false }
  } catch {
    return { additions: 0, deletions: 0, binary: true }
  }
}
