import { AppError } from '@poietica/foundation'
import { run, which } from '@poietica/process-kit'
import { reviewErrors } from '../contract'

/*
 * `gh` CLI 的薄封装。为什么是 gh 而不是自己发 HTTP：本仓没有 GitHub 集成，也不该为一个页面
 * 新引一套 OAuth —— 开发机上装了且登录了 gh，就已经有了一份可用的凭据与限流处理。
 * 代价写在 docs/refactor-log.md 的偏差里：没装 / 没登录时整页降级。
 *
 * 只读用户的仓库与凭据；不写全局配置、不注入 GH_TOKEN、不碰 ~/.config/gh。
 */

export interface GhResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** 跑一条 gh 命令。抽成类型是为了测试能换掉它 —— 测试里绝不真调 gh。 */
export type GhRunner = (
  args: readonly string[],
  options?: { readonly cwd?: string; readonly input?: string },
) => Promise<GhResult>

export const systemGhRunner: GhRunner = async (args, options) => {
  try {
    const result = await run('gh', [...args], {
      /* gh api 偶尔要几十秒（限流时更久），给一个上限免得把 RPC 的 60 秒预算吃光。 */
      timeoutMs: 45_000,
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options?.input === undefined ? {} : { input: options.input }),
      /* 非 0 退出不抛：由调用方按命令语义决定「这是失败还是正常结果」。 */
      okExitCodes: [0, 1, 2, 3, 4, 8],
    })
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  } catch (cause) {
    throw new AppError(reviewErrors.github_unavailable, '找不到 gh，请安装 GitHub CLI 并登录', {
      cause: String(cause),
    })
  }
}

function failure(stderr: string): AppError {
  const detail = stderr.trim().split('\n')[0] ?? ''
  return new AppError(reviewErrors.github_failed, detail === '' ? 'GitHub 请求失败' : detail, { stderr: detail })
}

/** `gh api <path>` 并解析 JSON。 */
export async function ghApiJson<T>(
  runner: GhRunner,
  path: string,
  options: { readonly cwd?: string; readonly input?: string } = {},
): Promise<T> {
  const result = await runner(['api', path], options)
  if (result.exitCode !== 0) {
    throw failure(result.stderr)
  }
  try {
    return JSON.parse(result.stdout) as T
  } catch (cause) {
    throw new AppError(reviewErrors.github_failed, 'gh 返回的不是 JSON', { cause: String(cause) })
  }
}

/* 变量一律走 -F/-f：用户输入因此永远不进查询正文，也就不存在注入面。 */
function variableArgs(variables: Readonly<Record<string, string | number | readonly string[]>>): readonly string[] {
  const args: string[] = []
  for (const [key, value] of Object.entries(variables)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        args.push('-f', `${key}[]=${String(item)}`)
      }
      continue
    }
    args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${String(value)}`)
  }
  return args
}

/** GraphQL：查询文本与变量分开传。 */
export async function ghGraphql<T>(
  runner: GhRunner,
  query: string,
  variables: Readonly<Record<string, string | number | readonly string[]>>,
  options: { readonly cwd?: string } = {},
): Promise<T> {
  const args = ['api', 'graphql', '-f', `query=${query}`, ...variableArgs(variables)]
  const result = await runner(args, options)
  if (result.exitCode !== 0) {
    throw failure(result.stderr)
  }
  let parsed: { readonly data?: T; readonly errors?: readonly { readonly message?: string }[] }
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed
  } catch (cause) {
    throw new AppError(reviewErrors.github_failed, 'gh 返回的不是 JSON', { cause: String(cause) })
  }
  if (parsed.data === undefined) {
    const message = parsed.errors?.[0]?.message ?? 'GitHub 请求失败'
    /* 「查不到这一条」是调用方要区分的情形，不能混进通用的失败里。 */
    if (/Could not resolve to a PullRequest/u.test(message)) {
      throw new AppError(reviewErrors.pull_request_missing, '这个 pull request 已经不在了', { stderr: message })
    }
    throw new AppError(reviewErrors.github_failed, message, { stderr: message })
  }
  return parsed.data
}

export interface GhAvailability {
  readonly path: string | null
  readonly login: string | null
}

/** 找 gh 并问一次「登录的是谁」。没装或没登录都不是异常 —— 它就是「这一页暂时没有数据源」。 */
export async function detectGh(runner: GhRunner = systemGhRunner): Promise<GhAvailability> {
  const found = await which('gh').catch(() => null)
  if (found === null) {
    return { path: null, login: null }
  }
  const result = await runner(['api', 'user', '--jq', '.login'])
  if (result.exitCode !== 0) {
    return { path: found, login: null }
  }
  const login = result.stdout.trim()
  return { path: found, login: login === '' ? null : login }
}
