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
  /** 自动加 -c core.quotepath=false，使非 ASCII 路径原样输出；参数数组，绝不拼接字符串。 */
  run(args: readonly string[], o?: GitRunOptions): Promise<RunResult>
  /** 不是仓库时返回 null（不抛错）。 */
  status(signal?: AbortSignal): Promise<PorcelainStatus | null>
  branches(signal?: AbortSignal): Promise<BranchEntry[]>
}

export interface CreateGitOptions {
  readonly cwd: string
  /** 测试注入；默认在第一次使用时 which('git')。 */
  readonly gitPath?: string
  readonly env?: Readonly<Record<string, string | undefined>>
}

const NOT_A_REPO = /not a git repository/i

/** RunError 分类：找不到 git / 不是仓库 / 其它命令失败（下次调用重新查找 git） */
function classify(e: RunError, args: readonly string[], cwd: string): Error {
  if (e.reason === 'spawn') return new GitNotFoundError(e.message)
  if (e.reason === 'exit' && NOT_A_REPO.test(e.stderr)) return new NotARepositoryError(`${cwd} 不是 git 仓库`)
  return new GitCommandError(e.reason, args, e.exitCode, e.stderr.slice(0, 2000))
}

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
      const classified = classify(e, args, o.cwd)
      // git 可能被卸载或移动：下次重新查找
      if (classified instanceof GitNotFoundError) resolved = o.gitPath
      throw classified
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

/** 引用名安全检查：空白或以 - 开头（会被 git 当成选项）→ GitRefusedError。 */
export function assertSafeRefName(label: string, value: string): void {
  if (value.trim() === '') throw new GitRefusedError(`${label}不能为空`)
  if (value.startsWith('-')) throw new GitRefusedError(`${label}不能以 - 开头：${value}`)
}
