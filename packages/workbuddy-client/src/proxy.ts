import { randomBytes } from 'node:crypto'
import type { WorkBuddyModel, WorkBuddySession } from './types'

export interface WorkBuddyProxyAccount {
  readonly id: string
  readonly session: WorkBuddySession
}

export interface WorkBuddyProxyOptions {
  /** 只放行这一条路径；由宿主启动时生成，换一次进程换一次。 */
  readonly secret: string
  readonly accounts: () => Promise<readonly WorkBuddyProxyAccount[]>
  readonly models: () => readonly WorkBuddyModel[]
  /** 某个账号被上游 401；宿主据此把账号标成需要重新登录。 */
  readonly onAuthFailure?: (accountId: string, status: number) => void
  /** 测试用；生产固定 WorkBuddy。 */
  readonly upstream?: string
  readonly log?: (message: string, data?: Record<string, unknown>) => void
}

export interface WorkBuddyProxy {
  readonly port: number
  /** 给 omp 的 baseUrl；带随机口令路径。 */
  readonly baseUrl: string
  stop(): void
}

const MAX_BODY_BYTES = 64 * 1024 * 1024
const DEFAULT_UPSTREAM = 'https://copilot.tencent.com/v2/chat/completions'

function failure(status: number, message: string, code: string): Response {
  return Response.json(
    { error: { message, type: 'invalid_request_error', code } },
    { status, headers: { 'cache-control': 'no-store' } },
  )
}

export function randomProxySecret(): string {
  return randomBytes(24).toString('hex')
}

type ChatBody = { readonly ok: true; readonly body: string } | { readonly ok: false; readonly response: Response }

async function readChatBody(request: Request): Promise<ChatBody> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: failure(413, '请求体过大', 'body_too_large') }
  }
  try {
    const body = await request.text()
    return body.length === 0 ? { ok: false, response: failure(400, '请求体为空', 'invalid_body') } : { ok: true, body }
  } catch {
    return { ok: false, response: failure(400, '读不到请求体', 'invalid_body') }
  }
}

async function sendToAccounts(
  options: WorkBuddyProxyOptions,
  accounts: readonly WorkBuddyProxyAccount[],
  upstream: string,
  body: string,
  signal: AbortSignal,
): Promise<Response> {
  let last: Response | null = null
  for (const [index, account] of accounts.entries()) {
    try {
      const response = await account.session.fetch(
        new Request(upstream, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body,
          signal,
        }),
      )
      if (response.status !== 401) return response
      options.onAuthFailure?.(account.id, response.status)
      if (index === accounts.length - 1) return response
      await response.body?.cancel().catch(() => undefined)
      last = response
    } catch (cause) {
      options.log?.('WorkBuddy 上游请求失败', { account: account.id, error: String(cause) })
      return failure(502, 'WorkBuddy 上游没有应答', 'upstream_unavailable')
    }
  }
  return last ?? failure(502, 'WorkBuddy 上游没有应答', 'upstream_unavailable')
}

async function handleChat(request: Request, options: WorkBuddyProxyOptions, upstream: string): Promise<Response> {
  if (request.method !== 'POST') return failure(405, 'method not allowed', 'method_not_allowed')
  const parsed = await readChatBody(request)
  if (!parsed.ok) return parsed.response
  let accounts: readonly WorkBuddyProxyAccount[]
  try {
    accounts = await options.accounts()
  } catch (cause) {
    options.log?.('读取 WorkBuddy 账号失败', { error: String(cause) })
    return failure(500, 'WorkBuddy 账号状态不可用', 'accounts_unavailable')
  }
  if (accounts.length === 0) return failure(401, '还没有登录 WorkBuddy 账号', 'not_signed_in')
  return await sendToAccounts(options, accounts, upstream, parsed.body, request.signal)
}

/**
 * 只做一件事：把 omp 发来的 OpenAI chat 请求交给指定账号的 WorkBuddy 通道。
 * 不接收任意上游 URL，不转发 Authorization，也不在本机之外监听。
 */
export function createWorkBuddyProxyHandler(options: WorkBuddyProxyOptions): (request: Request) => Promise<Response> {
  const prefix = `/p/${options.secret}/v1`
  const upstream = options.upstream ?? DEFAULT_UPSTREAM
  return async (request) => {
    const url = new URL(request.url)
    if (url.pathname === `${prefix}/health`) {
      return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
    }
    if (url.pathname === `${prefix}/models`) {
      return Response.json(
        {
          object: 'list',
          data: options.models().map((model) => ({ id: model.id, object: 'model', owned_by: 'workbuddy' })),
        },
        { headers: { 'cache-control': 'no-store' } },
      )
    }
    if (url.pathname !== `${prefix}/chat/completions`) return failure(404, 'not found', 'not_found')
    return await handleChat(request, options, upstream)
  }
}

export function startWorkBuddyProxy(options: WorkBuddyProxyOptions): WorkBuddyProxy {
  const prefix = `/p/${options.secret}/v1`
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: createWorkBuddyProxyHandler(options),
  })
  server.unref()
  const port = server.port ?? 0
  return {
    port,
    baseUrl: `http://127.0.0.1:${String(port)}${prefix}`,
    stop() {
      server.stop(true)
    },
  }
}
