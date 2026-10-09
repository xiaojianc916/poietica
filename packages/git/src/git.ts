import { RunError, type RunResult, run, which } from '@poietica/process-kit'
import { GitCommandError, GitNotFoundError, GitRefusedError, NotARepositoryError } from './errors'
import { BRANCH_FORMAT, type BranchEntry, type PorcelainStatus, parseForEachRef, parsePorcelainV2 } from './parse'

export interface GitRunOptions {
  readonly signal?: AbortSignal
  /** 默认 60 秒 */
  readonly timeoutMs?: number
  /** 默认 [0] */
  readonly okExitCodes?: readonly number[]
  readonly input?: string
}

export interface Git {
  readonly cwd: string
  /** 运行任意 git 子命令（参数数组，绝不拼接字符串）。自动加 -c core.quotepath=false，使非 ASCII 路径原样输出 */
  run(args: readonly string[], o?: GitRunOptions): Promise<RunResult>
  /** `status --porcelain=v2 --branch -z` 并解析；不是仓库时返回 null（不抛错） */
  status(signal?: AbortSignal): Promise<PorcelainStatus | null>
  /** 本地分支列表 */
  branches(signal?: AbortSignal): Promise<BranchEntry[]>
}

export interface CreateGitOptions {
  readonly cwd: string
  /** 测试注入；默认在第一次使用时 which('git') */
  readonly gitPath?: string
  /** 基础环境，默认 process.env */
  readonly env?: Readonly<Record<string, string | undefined>>
}

const NOT_A_REPO = /not a git repository/i

export function createGit(o: CreateGitOptions): Git {
  let resolved: string | undefined = o.gitPath
  const gitExe = async (): Promise<string> => {
    if (resolved !== undefined) return resolved
    const found = await which('git', o.env ?? process.env)
    if (found === null) throw new GitNotFoundError('找不到 git，请安装 Git for Windows')
    resolved = found
    return found
  }
  const env = {
    ...(o.env ?? process.env),
    GIT_TERMINAL_PROMPT: '0', // 需要凭据时直接失败，而不是挂起等待输入
    GIT_OPTIONAL_LOCKS: '0', // status 不去抢 index.lock，避免与用户自己的 git 操作冲突
    LC_ALL: 'C', // 错误信息为英文，NOT_A_REPO 匹配才可靠
  }

  const runGit = async (args: readonly string[], ro: GitRunOptions = {}): Promise<RunResult> => {
    const exe = await gitExe()
    const fullArgs = ['-c', 'core.quotepath=false', ...args]
    try {
      return await run(exe, fullArgs, {
        cwd: o.cwd,
        env,
        timeoutMs: ro.timeoutMs ?? 60_000,
        ...(ro.signal === undefined ? {} : { signal: ro.signal }),
        ...(ro.okExitCodes === undefined ? {} : { okExitCodes: ro.okExitCodes }),
        ...(ro.input === undefined ? {} : { input: ro.input }),
      })
    } catch (e) {
      if (!(e instanceof RunError)) throw e
      if (e.reason === 'spawn') {
        resolved = o.gitPath // 下次重新查找（git 可能被卸载或移动）
        throw new GitNotFoundError(e.message)
      }
      if (e.reason === 'exit' && NOT_A_REPO.test(e.stderr)) throw new NotARepositoryError(`${o.cwd} 不是 git 仓库`)
      throw new GitCommandError(e.reason, args, e.exitCode, e.stderr.slice(0, 2000))
    }
  }

  return {
    cwd: o.cwd,
    run: runGit,
    async status(signal) {
      try {
        const r = await runGit(['status', '--porcelain=v2', '--branch', '-z'], signal === undefined ? {} : { signal })
        return parsePorcelainV2(r.stdout)
      } catch (e) {
        if (e instanceof NotARepositoryError) return null
        throw e
      }
    },
    async branches(signal) {
      const r = await runGit(
        ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads'],
        signal === undefined ? {} : { signal },
      )
      return parseForEachRef(r.stdout)
    },
  }
}

/** 分支名等引用名的安全检查：空白或以 - 开头（会被 git 当成选项）→ GitRefusedError */
export function assertSafeRefName(label: string, value: string): void {
  if (value.trim() === '') throw new GitRefusedError(`${label}不能为空`)
  if (value.startsWith('-')) throw new GitRefusedError(`${label}不能以 - 开头：${value}`)
}
