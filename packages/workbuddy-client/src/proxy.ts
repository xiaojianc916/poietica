import { randomBytes } from 'node:crypto'
import type { WorkBuddyModel, WorkBuddySession } from './types'

export interface WorkBuddyProxyAccount {
  readonly id: string
  readonly session: WorkBuddySession
}

/** 一个账号这次为什么没答出来；宿主据此决定休息多久、要不要标成需要重新登录。 */
export type WorkBuddyFailureKind = 'sign_in' | 'restricted' | 'exhausted' | 'rate_limit'

export interface WorkBuddyAccountFailure {
  readonly kind: WorkBuddyFailureKind
  readonly status: number
  /** 插件写在响应上的 X-Magpie-Sign-In。只有 expired 才算登录真的没了，kept 只是这次被拒。 */
  readonly signIn: 'expired' | 'kept' | 'renewed' | null
}

export interface WorkBuddyProxyOptions {
  /** 只放行这一条路径；由宿主启动时生成，换一次进程换一次。 */
  readonly secret: string
  readonly accounts: () => Promise<readonly WorkBuddyProxyAccount[]>
  readonly models: () => readonly WorkBuddyModel[]
  /** 某个账号这次没答出来；宿主据此给它记休息时间，或按 signIn 决定标不标失效。 */
  readonly onAccountFailure?: (accountId: string, failure: WorkBuddyAccountFailure) => void
  /**
   * 这次答出来了，而且是上游给换了新令牌之后答出来的（X-Magpie-Sign-In: renewed）。
   * 之前记下的「需要重新登录」可以从这个账号上摘掉。
   */
  readonly onAccountRenewed?: (accountId: string) => void
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
/** 判错只读这么多；更大的错误体不判，原样交回去（正常错误体是几 KB 的 JSON）。 */
const MAX_ERROR_BYTES = 64 * 1024
const DEFAULT_UPSTREAM = 'https://copilot.tencent.com/v2/chat/completions'
const SIGN_IN_HEADER = 'x-magpie-sign-in'

/** 受限：403 code 11140。插件的 explained() 会把它改写成 permission_error。 */
const RESTRICTED =
  /account has been restricted due to unusual activity|账号存在异常行为|permission_error|["']code["']\s*:\s*["']?11140(?![\d.])/i
/** 额度用尽：code 14018。插件的 explained() 会把它改写成 insufficient_quota。 */
const EXHAUSTED = /credits exhausted|额度已用尽|insufficient_quota|["']code["']\s*:\s*["']?14018(?![\d.])/i

function failure(status: number, message: string, code: string): Response {
  return Response.json(
    { error: { message, type: 'invalid_request_error', code } },
    { status, headers: { 'cache-control': 'no-store' } },
  )
}

export function randomProxySecret(): string {
  return randomBytes(24).toString('hex')
}

/**
 * 上游的响应按 HTTP 边界收拾一遍：Bun 的 fetch 会自动解压，但把 content-encoding 留在头上，
 * 原样转出去下一跳就会二次解压（ZlibError）。X-Magpie-Sign-In 是 magpie 插件自己的协议，
 * 由这里读掉，不交给 omp。没有要收拾的就原样返回，不重建流。
 */
function passThrough(response: Response): Response {
  const encoding = response.headers.get('content-encoding')
  const compressed = encoding !== null && encoding !== 'identity' && encoding !== ''
  if (!compressed && !response.headers.has(SIGN_IN_HEADER)) return response
  const headers = new Headers(response.headers)
  headers.delete(SIGN_IN_HEADER)
  if (compressed) {
    headers.delete('content-encoding')
    headers.delete('content-length')
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function signInOf(response: Response): WorkBuddyAccountFailure['signIn'] {
  const said = response.headers.get(SIGN_IN_HEADER)?.trim().toLowerCase()
  return said === 'expired' || said === 'kept' || said === 'renewed' ? said : null
}

/** 状态码 + 错误体判这次算不算「这个账号不能用了」；null = 这请求本身有问题，不该换号。 */
function kindOf(status: number, text: string): WorkBuddyFailureKind | null {
  if (status === 401) return 'sign_in'
  if (status === 403 && RESTRICTED.test(text)) return 'restricted'
  if (status === 429) return EXHAUSTED.test(text) ? 'exhausted' : 'rate_limit'
  if (status === 400 && EXHAUSTED.test(text)) return 'exhausted'
  return null
}

interface Judgement {
  readonly response: Response
  readonly failure: WorkBuddyAccountFailure | null
}

/** 读完错误体再判：判得出的换号，判不出的把响应原样rebuilt 回去。 */
async function judgeFailure(response: Response): Promise<Judgement> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_ERROR_BYTES) {
    return { response: passThrough(response), failure: null }
  }
  let text: string
  try {
    text = await response.text()
  } catch {
    return { response: failure(502, 'WorkBuddy 上游的应答读不下来', 'upstream_unavailable'), failure: null }
  }
  const headers = new Headers(response.headers)
  headers.delete(SIGN_IN_HEADER)
  headers.delete('content-encoding')
  headers.delete('content-length')
  const rebuilt = new Response(text, { status: response.status, statusText: response.statusText, headers })
  const kind = kindOf(response.status, text)
  if (kind === null) return { response: rebuilt, failure: null }
  return { response: rebuilt, failure: { kind, status: response.status, signIn: signInOf(response) } }
}

type ChatBody = { readonly ok: true; readonly body: string } | { readonly ok: false; readonly response: Response }

async function readChatBody(request: Request): Promise<ChatBody> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: failure(413, '请求体过大', 'body_too_large') }
  }
  try {
    const body = await request.text()
    if (body.length === 0) return { ok: false, response: failure(400, '请求体为空', 'invalid_body') }
    if (body.length > MAX_BODY_BYTES) return { ok: false, response: failure(413, '请求体过大', 'body_too_large') }
    return { ok: true, body }
  } catch {
    return { ok: false, response: failure(400, '读不到请求体', 'invalid_body') }
  }
}

/**
 * 这一次问这个账号的结果。换号要读完整份错误体才判得出来，所以「可以换下一个」也得把
 * 那份应答带回来：最后一个账号没有下一个可换了，它手上这份就是该如实交回去的答复。
 */
type Attempt =
  { readonly done: Response } | { readonly done: null; readonly response: Response; readonly reason: string }

async function askAccount(
  options: WorkBuddyProxyOptions,
  account: WorkBuddyProxyAccount,
  upstream: string,
  body: string,
  signal: AbortSignal,
): Promise<Attempt> {
  let response: Response
  try {
    response = await account.session.fetch(
      new Request(upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body,
        signal,
      }),
    )
  } catch (cause) {
    /* 网络这类的失败换下一个账号再试：首选账号抖动时备用账号还能用 */
    options.log?.('WorkBuddy 上游请求失败', { account: account.id, error: String(cause) })
    return {
      done: null,
      response: failure(502, 'WorkBuddy 上游没有应答', 'upstream_unavailable'),
      reason: 'WorkBuddy 上游没有应答',
    }
  }
  if (response.status < 400) {
    if (signInOf(response) === 'renewed') options.onAccountRenewed?.(account.id)
    return { done: passThrough(response) }
  }
  const judged = await judgeFailure(response)
  if (judged.failure === null) return { done: judged.response }
  options.onAccountFailure?.(account.id, judged.failure)
  return { done: null, response: judged.response, reason: 'WorkBuddy 没有可用账号' }
}

async function sendToAccounts(
  options: WorkBuddyProxyOptions,
  accounts: readonly WorkBuddyProxyAccount[],
  upstream: string,
  body: string,
  signal: AbortSignal,
): Promise<Response> {
  const last = accounts.length - 1
  let reason = 'WorkBuddy 没有可用账号'
  for (const [index, account] of accounts.entries()) {
    const attempt = await askAccount(options, account, upstream, body, signal)
    if (attempt.done !== null) return attempt.done
    reason = attempt.reason
    /* 最后一个也换过了：把它手上那份应答如实交回去，不再空转 */
    if (index === last) return attempt.response
    await attempt.response.body?.cancel().catch(() => undefined)
  }
  return failure(502, reason, 'upstream_unavailable')
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
    try {
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
    } catch (cause) {
      /* 到这儿说明是我们自己出的错：不回 Bun 的 HTML 错误页，那页里带着完整口令路径 */
      options.log?.('WorkBuddy 反代处理请求失败', { error: String(cause) })
      return failure(500, 'WorkBuddy 反代内部错误', 'proxy_failed')
    }
  }
}

export function startWorkBuddyProxy(options: WorkBuddyProxyOptions): WorkBuddyProxy {
  const prefix = `/p/${options.secret}/v1`
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    /* 0 = 不限：模型的思考、上游排队都会让 SSE 静默超过 Bun 默认的 10 秒，而那条连接看着是好的 */
    idleTimeout: 0,
    maxRequestBodySize: MAX_BODY_BYTES,
    /* 没有这一格，Bun 会回一页 HTML 500，正文里带着请求 URL（含口令路径） */
    error: (cause) => {
      options.log?.('WorkBuddy 反代未捕获的异常', { error: String(cause) })
      return failure(500, 'WorkBuddy 反代内部错误', 'proxy_failed')
    },
    fetch: createWorkBuddyProxyHandler(options),
  })
  server.unref()
  const port = server.port ?? 0
  return {
    port,
    baseUrl: `http://127.0.0.1:${String(port)}${prefix}`,
    stop() {
      /* 关停不掐在途的流：omp 那边会把它看成上游故障。unref 过的 server 不会拖住进程退出 */
      void server.stop(false).catch((cause: unknown) => {
        options.log?.('WorkBuddy 反代关停失败', { error: String(cause) })
      })
    },
  }
}
