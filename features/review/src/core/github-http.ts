import { AppError } from '@poietica/foundation'
import { run, which } from '@poietica/process-kit'
import { reviewErrors } from '../contract'

/*
 * GitHub 的直连客户端：Core 进程自己发 HTTPS（REST + GraphQL），不再每个请求起一次 gh 子进程。
 *
 * 为什么换掉 gh：gh 每条命令都是「起进程 → 读配置 → 建 TLS 连接 → 请求 → 退出」，Windows 上光起进程就几百毫秒，
 * 而打开一条 PR 要连着跑 4～5 条（问登录、认仓库、读详情、读评论、读评审），每条都重新握手。直连之后连接由 fetch
 * 复用，仓库从本地 git 远端认，登录名只问一次 —— 一次打开就只剩真正要的那一两个请求。
 *
 * 凭据不新造一套 OAuth，按顺序借现成的（拿到一份就停）：
 *   1. 环境变量 GH_TOKEN / GITHUB_TOKEN；
 *   2. `gh auth token`（装了并登录过 gh 的机器，一次子进程，之后缓存）；
 *   3. `git credential fill`（Git for Windows 自带的凭据管理器里登录过 github.com 的那一份；禁止弹窗与终端提示）。
 * 只读，不写任何全局配置。凭据只活在内存里；GitHub 回 401 时丢掉缓存、重取一次。
 */

export const GITHUB_API = 'https://api.github.com'

/* 单个请求的上限：远小于 RPC 的 60 秒预算，网络卡住时页面能及时降级而不是一直转圈。 */
const REQUEST_TIMEOUT_MS = 30_000

/** 发请求。抽成类型是为了测试能换掉它 —— 测试里绝不真连 GitHub。 */
export type GithubFetch = (url: string, init: RequestInit) => Promise<Response>

/** 拿一份 token；拿不到交回 null（「这台机器没登录 GitHub」不是异常）。 */
export type TokenSource = () => Promise<string | null>

/** 跑一条本地命令（gh / git），只要退出码与输出。测试里换成假的。 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: { readonly input?: string },
) => Promise<{ readonly exitCode: number; readonly stdout: string } | null>

const systemCommand: CommandRunner = async (command, args, options) => {
  const found = await which(command).catch(() => null)
  if (found === null) {
    return null
  }
  try {
    const result = await run(found, [...args], {
      timeoutMs: 10_000,
      okExitCodes: [0, 1, 2, 128],
      /* 凭据管理器在拿不到凭据时会弹登录窗、git 会在终端里问密码：两样都关掉，拿不到就是拿不到。 */
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      ...(options?.input === undefined ? {} : { input: options.input }),
    })
    return { exitCode: result.exitCode, stdout: result.stdout }
  } catch {
    return null
  }
}

/** `git credential fill` 的回答是 key=value 行，取 password 那一行。 */
export function passwordFromCredential(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.startsWith('password=')) {
      const value = line.slice('password='.length).trim()
      return value === '' ? null : value
    }
  }
  return null
}

/** 按上面那三步的顺序找 token。 */
export function systemTokenSource(
  options: { readonly env?: Readonly<Record<string, string | undefined>>; readonly command?: CommandRunner } = {},
): TokenSource {
  const env = options.env ?? process.env
  const command = options.command ?? systemCommand
  return async () => {
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
      const value = env[name]?.trim()
      if (value !== undefined && value !== '') {
        return value
      }
    }
    const gh = await command('gh', ['auth', 'token', '--hostname', 'github.com'])
    const fromGh = gh?.exitCode === 0 ? gh.stdout.trim() : ''
    if (fromGh !== '') {
      return fromGh
    }
    const git = await command('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' })
    return git?.exitCode === 0 ? passwordFromCredential(git.stdout) : null
  }
}

export interface GithubClient {
  /** 当前凭据（缓存）；没有就是 null。 */
  token(): Promise<string | null>
  /** REST：path 以 / 开头（相对 api.github.com）。404 时交回 AppError(github_failed, data.status=404)。 */
  rest<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown): Promise<T>
  /** GraphQL：查询文本与变量分开传，用户输入永远不进查询正文。 */
  graphql<T>(query: string, variables: Readonly<Record<string, unknown>>): Promise<T>
}

export interface GithubClientDeps {
  readonly fetch?: GithubFetch
  readonly tokens?: TokenSource
}

function noCredentials(): AppError {
  return new AppError(
    reviewErrors.github_unavailable,
    '没找到 GitHub 凭据：设置 GITHUB_TOKEN，或运行 gh auth login 后回到这一页',
  )
}

/** GitHub 的错误体是 { message, errors? }；读不出来就用状态码说话。 */
async function messageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { readonly message?: string }
    if (typeof body.message === 'string' && body.message !== '') {
      return body.message
    }
  } catch {
    // 不是 JSON：落到下面的状态码
  }
  return `GitHub 回了 HTTP ${String(response.status)}`
}

/* 发一次请求；网络层的失败（断网、代理不通、超时）在这里翻成人话。 */
async function sendOnce(
  send: GithubFetch,
  method: string,
  url: string,
  body: unknown,
  current: string,
): Promise<Response> {
  const hasBody = body !== undefined
  try {
    return await send(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${current}`,
        'user-agent': 'poietica',
        'x-github-api-version': '2022-11-28',
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (cause) {
    const timedOut = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')
    throw new AppError(reviewErrors.github_failed, timedOut ? '连接 GitHub 超时' : '连不上 GitHub，请检查网络或代理', {
      cause: String(cause),
    })
  }
}

export function createGithubClient(d: GithubClientDeps = {}): GithubClient {
  const send = d.fetch ?? ((url, init) => fetch(url, init))
  const tokens = d.tokens ?? systemTokenSource()
  /* 并发的第一次取凭据只跑一遍：页面一打开就是列表、详情、评论三路同时来。 */
  let cached: Promise<string | null> | null = null

  const token = (): Promise<string | null> => {
    cached ??= tokens().catch(() => null)
    return cached
  }

  async function request(method: string, url: string, body: unknown, retried = false): Promise<Response> {
    const current = await token()
    if (current === null) {
      /* 没拿到也别永远记住「没有」：用户可能刚在终端里登录完，下一次请求重新找。 */
      cached = null
      throw noCredentials()
    }
    const response = await sendOnce(send, method, url, body, current)
    if (response.status === 401) {
      /* 凭据过期或被吊销：丢掉缓存重取一次（gh 可能已经刷新过），还不行才算没登录。 */
      cached = null
      if (!retried) {
        return request(method, url, body, true)
      }
      throw new AppError(
        reviewErrors.github_unavailable,
        'GitHub 凭据已失效：重新运行 gh auth login 或更新 GITHUB_TOKEN',
      )
    }
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      throw new AppError(reviewErrors.github_failed, '触发了 GitHub 的请求限额，稍后再试')
    }
    return response
  }

  return {
    token,

    async rest<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown): Promise<T> {
      const response = await request(method, `${GITHUB_API}${path}`, body)
      if (!response.ok) {
        const message = await messageOf(response)
        throw new AppError(reviewErrors.github_failed, message, { status: response.status, stderr: message })
      }
      if (response.status === 204) {
        return undefined as T
      }
      try {
        return (await response.json()) as T
      } catch (cause) {
        throw new AppError(reviewErrors.github_failed, 'GitHub 返回的不是 JSON', { cause: String(cause) })
      }
    },

    async graphql<T>(query: string, variables: Readonly<Record<string, unknown>>): Promise<T> {
      const response = await request('POST', `${GITHUB_API}/graphql`, { query, variables })
      if (!response.ok) {
        const message = await messageOf(response)
        throw new AppError(reviewErrors.github_failed, message, { status: response.status, stderr: message })
      }
      let parsed: { readonly data?: T | null; readonly errors?: readonly { readonly message?: string }[] }
      try {
        parsed = (await response.json()) as typeof parsed
      } catch (cause) {
        throw new AppError(reviewErrors.github_failed, 'GitHub 返回的不是 JSON', { cause: String(cause) })
      }
      const firstError = parsed.errors?.[0]?.message
      /* 「查不到这一条」是调用方要区分的情形，不能混进通用的失败里。GitHub 这时 data 里对应字段是 null，同时带一条 error。 */
      if (firstError !== undefined && /Could not resolve to a PullRequest/u.test(firstError)) {
        throw new AppError(reviewErrors.pull_request_missing, '这个 pull request 已经不在了', { stderr: firstError })
      }
      if (parsed.data === undefined || parsed.data === null) {
        const message = firstError ?? 'GitHub 请求失败'
        throw new AppError(reviewErrors.github_failed, message, { stderr: message })
      }
      return parsed.data
    },
  }
}

/* ── 仓库：从本地 git 远端认，不问网络 ─────────────────────────────────────── */

export interface RemoteRepository {
  readonly owner: string
  readonly name: string
}

/**
 * 认 github.com 的三种远端写法：https://github.com/o/r(.git)、git@github.com:o/r(.git)、ssh://git@github.com/o/r(.git)。
 * 其它主机（GitLab、自建 GHE）交回 null —— 这一页只接 github.com。
 */
export function parseGithubRemote(url: string): RemoteRepository | null {
  const trimmed = url.trim()
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git:\/\/|(?:[^@/]+@))?(?:www\.)?github\.com[:/]([^/\s]+?)\/([^/\s]+?)(?:\.git)?\/?$/iu.exec(
      trimmed,
    )
  if (match === null) {
    return null
  }
  const owner = match[1] ?? ''
  const name = match[2] ?? ''
  return owner === '' || name === '' ? null : { owner, name }
}

/**
 * 从 `git remote -v` 的输出里挑一个 GitHub 仓库：origin 优先，其次 upstream，再其次第一个指向 github.com 的远端。
 * （与 gh 的默认挑法同一个顺序的子集。）
 */
export function pickGithubRemote(remoteVerbose: string): RemoteRepository | null {
  const found = new Map<string, RemoteRepository>()
  for (const line of remoteVerbose.split(/\r?\n/u)) {
    const [remote, url] = line.trim().split(/\s+/u)
    if (remote === undefined || url === undefined || found.has(remote)) {
      continue
    }
    const parsed = parseGithubRemote(url)
    if (parsed !== null) {
      found.set(remote, parsed)
    }
  }
  return found.get('origin') ?? found.get('upstream') ?? found.values().next().value ?? null
}
