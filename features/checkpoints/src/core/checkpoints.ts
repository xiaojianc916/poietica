import { createHash } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '@poietica/foundation'
import { RunError, run, which } from '@poietica/process-kit'
import type {
  Checkpoint,
  CheckpointChangedPathsParams,
  CheckpointCreateParams,
  CheckpointDiffParams,
  CheckpointRestoreParams,
  CheckpointRestoreResult,
} from '../contract/entities'
import type { CheckpointService } from '../core-api'

export interface CreateCheckpointServiceOptions {
  /** 影子仓库根目录（应用数据目录内，不放用户项目里） */
  readonly dir: string
  /** 测试注入；默认第一次使用时 which('git') */
  readonly gitPath?: string
  /** 测试注入；默认 process.env */
  readonly env?: Readonly<Record<string, string | undefined>>
}

interface CheckpointMeta {
  readonly workspaceRoot?: string
  readonly threadId?: string
  readonly runId?: string
  readonly stepId?: string
  readonly label?: string
}

const IDENTITY = [
  '-c',
  'user.name=Poietica',
  '-c',
  'user.email=checkpoint@poietica.local',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'core.bare=false',
] as const

const DIFF_LIMIT = 64 * 1024 * 1024

/** 影子检查点：每个工作区一个独立 git 仓库，以用户工作树为 work-tree（§14.2）。 */
export function createCheckpointService(o: CreateCheckpointServiceOptions): CheckpointService {
  let resolved = o.gitPath
  const env = o.env ?? process.env
  const initLocks = new Map<string, Promise<void>>()

  const gitExe = async (): Promise<string> => {
    if (resolved !== undefined) return resolved
    const found = await which('git', env)
    if (found === null) throw new AppError('checkpoints.git_failed', '找不到 git，请安装 Git for Windows')
    resolved = found
    return found
  }

  const repoDirOf = (workspaceRoot: string): string => {
    const key = createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 32)
    return path.join(o.dir, `${key}.git`)
  }

  /** 影子仓库可能落在工作树内（测试、或用户把数据目录放进项目）：它自己的文件不算这一轮的改动。 */
  const visiblePaths = (workspaceRoot: string, paths: readonly string[]): string[] => {
    const shadowRel = path.relative(workspaceRoot, repoDirOf(workspaceRoot)).split(path.sep).join('/')
    if (shadowRel.startsWith('..') || path.isAbsolute(shadowRel)) return [...paths]
    return paths.filter((entry) => entry !== shadowRel && !entry.startsWith(`${shadowRel}/`))
  }

  const shadowEnv = (repoDir: string, workspaceRoot: string, includeGitDir = true) => ({
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    ...(includeGitDir ? { GIT_DIR: repoDir, GIT_WORK_TREE: workspaceRoot } : {}),
  })

  const ensureRepo = async (workspaceRoot: string): Promise<string> => {
    const repoDir = repoDirOf(workspaceRoot)
    const pending = initLocks.get(repoDir)
    if (pending !== undefined) {
      await pending
      return repoDir
    }
    const init = (async () => {
      try {
        await stat(path.join(repoDir, 'HEAD'))
        return
      } catch {
        // 还没有影子仓库
      }
      await mkdir(o.dir, { recursive: true })
      const exe = await gitExe()
      try {
        await run(exe, ['init', '--quiet', '--bare', repoDir], {
          cwd: workspaceRoot,
          env: shadowEnv(repoDir, workspaceRoot, false),
        })
      } catch (e) {
        throw gitFailure(e, ['init', repoDir])
      }
    })()
    initLocks.set(repoDir, init)
    try {
      await init
    } finally {
      initLocks.delete(repoDir)
    }
    return repoDir
  }

  const shadow = async (
    workspaceRoot: string,
    args: readonly string[],
    options: { readonly okExitCodes?: readonly number[]; readonly maxOutputBytes?: number } = {},
  ) => {
    const repoDir = await ensureRepo(workspaceRoot)
    const exe = await gitExe()
    try {
      return await run(exe, [...IDENTITY, ...args], {
        cwd: workspaceRoot,
        env: shadowEnv(repoDir, workspaceRoot),
        timeoutMs: 120_000,
        ...(options.okExitCodes === undefined ? {} : { okExitCodes: options.okExitCodes }),
        maxOutputBytes: options.maxOutputBytes ?? 16 * 1024 * 1024,
      })
    } catch (e) {
      throw gitFailure(e, args)
    }
  }

  const createOnce = async (workspaceRoot: string, input: CheckpointCreateParams): Promise<Checkpoint> => {
    const meta = checkpointMeta(workspaceRoot, input)
    const repoDir = await ensureRepo(workspaceRoot)
    const shadowRel = path.relative(workspaceRoot, repoDir)
    /* 跨盘符时 path.relative 返回绝对路径（如 C:\...），不能当成仓库内相对路径传 --exclude */
    const outsideWorkspace = shadowRel.startsWith('..') || path.isAbsolute(shadowRel)
    const exclude = shadowRel.length > 0 && !outsideWorkspace ? [`:(exclude)${shadowRel.replaceAll('\\', '/')}/**`] : []
    await shadow(workspaceRoot, ['add', '-A', '--', '.', ...exclude])
    await shadow(workspaceRoot, ['commit', '--allow-empty', '--no-verify', '-m', JSON.stringify(meta)])
    const id = (await shadow(workspaceRoot, ['rev-parse', 'HEAD'])).stdout.trim()
    const createdAt = (await shadow(workspaceRoot, ['show', '-s', '--format=%cI', 'HEAD'])).stdout.trim()
    return {
      id,
      workspaceRoot,
      createdAt,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
      ...(input.label === undefined ? {} : { label: input.label }),
    }
  }

  /* 同一工作区串行提交：轮结束与下一轮开始可能几乎同时发生，git index 不能并发写，顺序也要稳定。 */
  const createTails = new Map<string, Promise<void>>()
  const create = async (input: CheckpointCreateParams): Promise<Checkpoint> => {
    const workspaceRoot = path.resolve(input.workspaceRoot)
    const previous = createTails.get(workspaceRoot) ?? Promise.resolve()
    const run = previous.then(
      () => createOnce(workspaceRoot, input),
      () => createOnce(workspaceRoot, input),
    )
    createTails.set(
      workspaceRoot,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return await run
  }

  const list = async (workspaceRootInput: string, limit = 50): Promise<Checkpoint[]> => {
    const workspaceRoot = path.resolve(workspaceRootInput)
    const n = Math.min(Math.max(limit, 1), 200)
    const result = await shadow(workspaceRoot, ['log', '-n', String(n), '--format=%H%x00%cI%x00%s', '--'])
    return result.stdout
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => {
        const [id = '', createdAt = '', subject = ''] = line.split('\u0000')
        const meta = parseMeta(subject)
        return {
          id,
          workspaceRoot: meta.workspaceRoot ?? workspaceRoot,
          createdAt,
          ...(meta.threadId === undefined ? {} : { threadId: meta.threadId }),
          ...(meta.runId === undefined ? {} : { runId: meta.runId }),
          ...(meta.stepId === undefined ? {} : { stepId: meta.stepId }),
          ...(meta.label === undefined ? {} : { label: meta.label }),
        }
      })
  }

  const diff = async (input: CheckpointDiffParams): Promise<string> => {
    const workspaceRoot = path.resolve(input.workspaceRoot)
    const result = await shadow(workspaceRoot, ['diff', '--no-color', '--binary', input.from, input.to, '--'], {
      maxOutputBytes: DIFF_LIMIT,
    })
    return result.stdout
  }

  const diffPaths = async (input: CheckpointDiffParams): Promise<string[]> => {
    const workspaceRoot = path.resolve(input.workspaceRoot)
    const result = await shadow(workspaceRoot, ['diff', '--name-only', '-z', input.from, input.to, '--'])
    return visiblePaths(workspaceRoot, splitNul(result.stdout))
  }

  const changedPaths = async (input: CheckpointChangedPathsParams): Promise<string[]> => {
    const workspaceRoot = path.resolve(input.workspaceRoot)
    const tracked = await shadow(workspaceRoot, ['diff', '--name-only', '-z', input.checkpoint, '--'])
    const untracked = await shadow(workspaceRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--'])
    return visiblePaths(workspaceRoot, [...new Set([...splitNul(tracked.stdout), ...splitNul(untracked.stdout)])])
  }

  const restore = async (input: CheckpointRestoreParams): Promise<CheckpointRestoreResult> => {
    const workspaceRoot = path.resolve(input.workspaceRoot)
    const paths = input.paths.map((p) => safeRelative(workspaceRoot, p))
    if (input.expect !== undefined) {
      const wanted = new Set(paths)
      const drift = (await changedPaths({ workspaceRoot, checkpoint: input.expect })).filter((p) => wanted.has(p))
      if (drift.length > 0) {
        throw new AppError('checkpoints.conflict', '工作区在这一轮之后又被改过，恢复会覆盖这些改动', {
          paths: drift,
        })
      }
    }
    const dirty = await shadow(workspaceRoot, ['status', '--porcelain', '--', ...paths])
    if (dirty.stdout.trim() !== '') {
      throw new AppError('checkpoints.conflict', '工作区在最近检查点之后被手动改过，恢复会覆盖这些改动')
    }
    const existing: string[] = []
    for (const entry of paths) {
      const listed = await shadow(workspaceRoot, ['ls-tree', '--name-only', '-z', input.checkpoint, '--', entry])
      if (splitNul(listed.stdout).includes(entry)) existing.push(entry)
      /* 检查点里没有这个文件：这一轮新建的，撤销就是删掉。 */
      else await rm(path.join(workspaceRoot, entry), { force: true })
    }
    if (existing.length > 0) await shadow(workspaceRoot, ['checkout', input.checkpoint, '--', ...existing])
    // 撤销本身也打点，保证「撤销的撤销」成立（§14.3）
    await create({ workspaceRoot, label: `revert ${input.checkpoint.slice(0, 12)}` })
    return { restored: paths }
  }

  return { create, list, diff, diffPaths, changedPaths, restore }
}

/** git 的 `-z` 输出：NUL 分隔、路径原样（不转义空格与中文）。 */
function splitNul(stdout: string): string[] {
  return stdout.split('\u0000').filter((line) => line.length > 0)
}

function checkpointMeta(workspaceRoot: string, input: CheckpointCreateParams): CheckpointMeta {
  return {
    workspaceRoot,
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    ...(input.label === undefined ? {} : { label: input.label }),
  }
}

function parseMeta(subject: string): CheckpointMeta {
  try {
    const value = JSON.parse(subject) as unknown
    if (typeof value !== 'object' || value === null) return { label: subject }
    const record = value as Record<string, unknown>
    return {
      ...(typeof record.workspaceRoot === 'string' ? { workspaceRoot: record.workspaceRoot } : {}),
      ...(typeof record.threadId === 'string' ? { threadId: record.threadId } : {}),
      ...(typeof record.runId === 'string' ? { runId: record.runId } : {}),
      ...(typeof record.stepId === 'string' ? { stepId: record.stepId } : {}),
      ...(typeof record.label === 'string' ? { label: record.label } : {}),
    }
  } catch {
    return { label: subject }
  }
}

/** 只接受工作区内的相对路径；绝对路径与 `..` 一律拒绝。 */
function safeRelative(workspaceRoot: string, input: string): string {
  const absolute = path.resolve(workspaceRoot, input)
  const relative = path.relative(workspaceRoot, absolute)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError('checkpoints.invalid_path', `路径不在工作区内：${input}`)
  }
  return relative.split(path.sep).join('/')
}

function gitFailure(error: unknown, args: readonly string[]): AppError {
  if (error instanceof AppError) return error
  if (error instanceof RunError) {
    return new AppError('checkpoints.git_failed', `git ${args[0] ?? ''} 失败：${error.message}`, {
      exitCode: error.exitCode,
      stderr: error.stderr.slice(0, 2000),
    })
  }
  return new AppError('checkpoints.git_failed', error instanceof Error ? error.message : String(error))
}
