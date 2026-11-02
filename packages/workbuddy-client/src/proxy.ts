import { randomBytes } from 'node:crypto'
import type { WorkBuddyModel, WorkBuddySession } from './types'

export interface WorkBuddyProxyAccount {
  readonly id: string
  readonly session: WorkBuddySession
}

/** 一个账号这次为什么没答出来；宿主据此决定休息多久、要不要标成需要重新登录。 */
export type WorkBuddyFailureKind = 'sign_in' | 'restricted' | 'exhausted' | 'rate_limit' | 'unknown'

export interface WorkBuddyAccountFailure {
  readonly kind: WorkBuddyFailureKind
  readonly status: number
  /** 插件写在响应上的 X-Magpie-Sign-In。只有 expired 才算登录真的没了，kept 只是这次被拒。 */
  readonly signIn: 'expired' | 'kept' | 'renewed' | null
  /**
   * 上游自己在这次拒绝里写下的恢复时刻（epoch ms）。WorkBuddy 的限流是 24 小时 token 窗口，
   * 429 正文里会写「将在 2026-11-02 19:17:02 UTC+8 重置」；照它休息比按固定时长猜省得多。
   */
  readonly resetAt?: number
  /** 这次问的模型 id；按模型休息（只让这个模型歇着）要用它。 */
  readonly model?: string
}

/** 宿主交给反代的名单。账号为空时，restingUntil 区分「一个号都没有」与「都还在休息」。 */
export interface WorkBuddyProxyAccounts {
  readonly accounts: readonly WorkBuddyProxyAccount[]
  readonly restingUntil?: number
}

export interface WorkBuddyProxyOptions {
  /** 只放行这一条路径；由宿主启动时生成，换一次进程换一次。 */
  readonly secret: string
  readonly accounts: () => Promise<WorkBuddyProxyAccounts>
  readonly models: () => readonly WorkBuddyModel[]
  /** 某个账号这次没答出来；宿主据此给它记休息时间，或按 signIn 决定标不标失效。 */
  readonly onAccountFailure?: (accountId: string, failure: WorkBuddyAccountFailure) => void
  /**
   * 这次答出来了，而且是上游给换了新令牌之后答出来的（X-Magpie-Sign-In: renewed）。
   * 之前记下的「需要重新登录」可以从这个账号上摘掉。
   */
  readonly onAccountRenewed?: (accountId: string) => void
  /**
   * 这次答出来了（任何一次成功）。magpie 在每次成功应答上清掉该账号的连续失败计数与休息：
   * 偶发一次限流不该让这个号一路翻倍到半小时。
   */
  readonly onAccountAnswered?: (accountId: string) => void
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
/** 插件的会话头：插件 sessionOf 读走并删掉，不会外泄给上游。 */
const SESSION_HEADER = 'x-magpie-workbuddy-session'
/** omp 发来的会话身份；omp 的 models.yml 用 compat.promptCacheSessionHeader 发这个头。 */
const CONVERSATION_HEADER = 'x-conversation-id'

/** 受限：code 11140。插件的 explained() 会把它写回 error.code，正则只是解析失败时的兜底。 */
const RESTRICTED = /account has been restricted due to unusual activity|账号存在异常行为|帳號存在異常行為/i
const RESTRICTED_CODE = 11140
/** 额度用尽：code 14018。同样以结构化 code 为准。 */
const EXHAUSTED = /credits exhausted|额度已用尽/i
const EXHAUSTED_CODE = 14018
/** 上游自己在拒绝里写的恢复时刻：「将在 2026-11-02 19:17:02 UTC+8 重置」/「will reset at …」。 */
const RESET_AT = /(?:reset at|将在|将于)\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})/i
const RESET_OFFSET = /\b(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?\b/i
/** 上游自己写的时刻最多信到 7 天：更远的多半是把别的日期读成了重置时刻（magpie 的 longestWritten）。 */
const MAX_RESET_AHEAD_MS = 7 * 24 * 60 * 60 * 1000
/**
 * 上游的头里哪些不能交给 omp：cookie、认证挑战、缓存与跳转这类由反代说了算的语义头。
 * magpie 有一份同样的拒绝名单（provider/replyheaders.go）：那是给浏览器与中转看的，
 * 漏给客户端会让下一跳按别人的缓存策略或挑战头做二次判断。
 */
const PRIVATE_HEADERS = [
  'set-cookie',
  'www-authenticate',
  'proxy-authenticate',
  'cache-control',
  'expires',
  'pragma',
  'location',
  'content-encoding',
  'content-length',
  'transfer-encoding',
]

function failure(status: number, message: string, code: string, retryAfterSeconds?: number): Response {
  const headers: Record<string, string> = { 'cache-control': 'no-store' }
  if (retryAfterSeconds !== undefined) {
    headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterSeconds)))
  }
  return Response.json({ error: { message, type: 'invalid_request_error', code } }, { status, headers })
}

export function randomProxySecret(): string {
  return randomBytes(24).toString('hex')
}

/** 剥掉上游不该给客户端的头，并把解压后残留的 content-encoding 一起拿掉。 */
function withoutPrivate(headers: Headers): Headers {
  const out = new Headers(headers)
  for (const name of PRIVATE_HEADERS) out.delete(name)
  out.delete(SIGN_IN_HEADER)
  return out
}

/**
 * 上游的响应按 HTTP 边界收拾一遍：Bun 的 fetch 会自动解压，但把 content-encoding 留在头上，
 * 原样转出去下一跳就会二次解压（ZlibError）。X-Magpie-Sign-In 是上游客户端之间的私有协议，
 * 由这里读掉；cookie 与认证挑战同理。已经干净的就原样返回，不碰那条流。
 */
function passThrough(response: Response): Response {
  const dirty = PRIVATE_HEADERS.some((name) => response.headers.has(name)) || response.headers.has(SIGN_IN_HEADER)
  if (!dirty) return response
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: withoutPrivate(response.headers),
  })
}

function signInOf(response: Response): WorkBuddyAccountFailure['signIn'] {
  const said = response.headers.get(SIGN_IN_HEADER)?.trim().toLowerCase()
  return said === 'expired' || said === 'kept' || said === 'renewed' ? said : null
}

/** 错误体里的结构化 code：插件已经把 11140 / 14018 写在 error.code 上。 */
function codesOf(text: string): number[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const record = parsed as Record<string, unknown>
  const error = (record.error ?? {}) as Record<string, unknown>
  const data = (record.data ?? {}) as Record<string, unknown>
  const inner = (error.data ?? {}) as Record<string, unknown>
  return [error.code, record.code, data.code, error.internal_code, inner.code]
    .map((code) => (typeof code === 'number' ? code : typeof code === 'string' ? Number(code) : Number.NaN))
    .filter((code) => Number.isFinite(code))
}

/** 上游拒绝里写下的恢复时刻；读不出就是 undefined —— 偏移必须自己写出来，不猜时区。 */
function resetAtOf(text: string, now: number): number | undefined {
  const at = RESET_AT.exec(text)
  if (at === null) return undefined
  const offset = RESET_OFFSET.exec(text)
  if (offset === null) return undefined
  const minutes = Number(offset[2]) * 60 + Number(offset[3] ?? 0)
  if (minutes > 14 * 60) return undefined
  const [, year, month, day, hour, minute, second] = at
  const signed = offset[1] === '-' ? -minutes : minutes
  const when = Date.UTC(+year!, +month! - 1, +day!, +hour!, +minute!, +second!) - signed * 60_000
  if (!Number.isFinite(when) || when <= now || when - now > MAX_RESET_AHEAD_MS) return undefined
  return when
}

/** 这一次问的是哪个模型。 */
function modelOf(body: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const model = (parsed as { model?: unknown }).model
  return typeof model === 'string' && model !== '' ? model : undefined
}

/**
 * 状态码 + 错误体判这次算不算「这个账号不能用了」；null = 这请求本身有问题，不该换号。
 *
 * 与 magpie 的失败分类一一对应（internal/gateway/routing.go 的 restAfter）：401 换号不休息、
 * 11140 受限、14018 额度用尽、429 限流；其余的 5xx / 408 归「上游这次出的问题」——
 * 换下一个账号并记一次退避，而不是把这份应答当场交回去。
 */
function kindOf(status: number, text: string): WorkBuddyFailureKind | null {
  const codes = codesOf(text)
  if (status === 401) return 'sign_in'
  if (status === 403) {
    return codes.includes(RESTRICTED_CODE) || RESTRICTED.test(text) ? 'restricted' : null
  }
  if (status === 429) {
    return codes.includes(EXHAUSTED_CODE) || EXHAUSTED.test(text) ? 'exhausted' : 'rate_limit'
  }
  if (status === 400) {
    return codes.includes(EXHAUSTED_CODE) || EXHAUSTED.test(text) ? 'exhausted' : null
  }
  if (status >= 500 || status === 408) return 'unknown'
  return null
}

interface Judgement {
  readonly response: Response
  readonly failure: WorkBuddyAccountFailure | null
}

/** 读完错误体再判：判得出的换号，判不出的把响应原样重建回去。 */
async function judgeFailure(response: Response, now: number, model: string | undefined): Promise<Judgement> {
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
  const rebuilt = new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: withoutPrivate(response.headers),
  })
  const kind = kindOf(response.status, text)
  if (kind === null) return { response: rebuilt, failure: null }
  const resetAt = resetAtOf(text, now)
  return {
    response: rebuilt,
    failure: {
      kind,
      status: response.status,
      signIn: signInOf(response),
      ...(resetAt === undefined ? {} : { resetAt }),
      ...(model === undefined ? {} : { model }),
    },
  }
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
 * 交给上游的头：内容类型与流式声明由反代自己定（插件会按 WorkBuddy 的要求覆盖它们）；
 * 会话身份透传下去 —— 插件靠它算 X-Conversation-ID，同一会话跨 Core 重启才是同一个会话。
 */
function upstreamHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' }
  const session = request.headers.get(CONVERSATION_HEADER)?.trim()
  if (session !== undefined && session !== '') headers[SESSION_HEADER] = session
  return headers
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
  headers: Record<string, string>,
  body: string,
  model: string | undefined,
  signal: AbortSignal,
  at: number,
): Promise<Attempt> {
  let response: Response
  try {
    response = await account.session.fetch(new Request(upstream, { method: 'POST', headers, body, signal }))
  } catch (cause) {
    /*
     * 客户端自己取消的，不算上游故障：这时换下一个账号等于替一个已经没人要的请求再打一次上游，
     * 还会把「用户按了停止」记成这个号的失败。magpie 同样记 failCanceled、不换号。
     */
    if (signal.aborted) return { done: failure(499, '客户端已取消这次请求', 'request_cancelled') }
    options.log?.('WorkBuddy 上游请求失败', { account: account.id, error: String(cause) })
    return {
      done: null,
      response: failure(502, 'WorkBuddy 上游没有应答', 'upstream_unavailable'),
      reason: 'WorkBuddy 上游没有应答',
    }
  }
  if (response.status < 400) {
    options.onAccountAnswered?.(account.id)
    if (signInOf(response) === 'renewed') options.onAccountRenewed?.(account.id)
    return { done: passThrough(response) }
  }
  const judged = await judgeFailure(response, at, model)
  if (judged.failure === null) return { done: judged.response }
  options.onAccountFailure?.(account.id, judged.failure)
  return { done: null, response: judged.response, reason: 'WorkBuddy 没有可用账号' }
}

async function sendToAccounts(
  options: WorkBuddyProxyOptions,
  accounts: readonly WorkBuddyProxyAccount[],
  upstream: string,
  headers: Record<string, string>,
  body: string,
  model: string | undefined,
  signal: AbortSignal,
  now: () => number,
): Promise<Response> {
  const last = accounts.length - 1
  let reason = 'WorkBuddy 没有可用账号'
  for (const [index, account] of accounts.entries()) {
    if (signal.aborted) return failure(499, '客户端已取消这次请求', 'request_cancelled')
    const attempt = await askAccount(options, account, upstream, headers, body, model, signal, now())
    if (attempt.done !== null) return attempt.done
    reason = attempt.reason
    /* 最后一个也换过了：把它手上那份应答如实交回去，不再空转 */
    if (index === last) return attempt.response
    await attempt.response.body?.cancel().catch(() => undefined)
  }
  return failure(502, reason, 'upstream_unavailable')
}

/** 有账号、但都还在休息：429 + Retry-After，说的是「等一下再来」，不是「登录没了」。 */
function allResting(restingUntil: number, now: number): Response {
  const seconds = Math.max(1, Math.ceil((restingUntil - now) / 1000))
  const minutes = Math.ceil(seconds / 60)
  return failure(
    429,
    `所有 WorkBuddy 账号都在冷却，最早 ${String(minutes)} 分钟后恢复`,
    'all_accounts_resting',
    seconds,
  )
}

async function handleChat(
  request: Request,
  options: WorkBuddyProxyOptions,
  upstream: string,
  now: () => number,
): Promise<Response> {
  if (request.method !== 'POST') return failure(405, 'method not allowed', 'method_not_allowed')
  const parsed = await readChatBody(request)
  if (!parsed.ok) return parsed.response
  let handed: WorkBuddyProxyAccounts
  try {
    handed = await options.accounts()
  } catch (cause) {
    options.log?.('读取 WorkBuddy 账号失败', { error: String(cause) })
    return failure(500, 'WorkBuddy 账号状态不可用', 'accounts_unavailable')
  }
  if (handed.accounts.length === 0) {
    /* 一个号都没有与「都还在休息」是两件事：前者要重新登录，后者等一下就好 */
    if (handed.restingUntil !== undefined) return allResting(handed.restingUntil, now())
    return failure(401, '还没有登录 WorkBuddy 账号', 'not_signed_in')
  }
  return await sendToAccounts(
    options,
    handed.accounts,
    upstream,
    upstreamHeaders(request),
    parsed.body,
    modelOf(parsed.body),
    request.signal,
    now,
  )
}

/**
 * 只做一件事：把 omp 发来的 OpenAI chat 请求交给指定账号的 WorkBuddy 通道。
 * 不接收任意上游 URL，不转发 Authorization，也不在本机之外监听。
 */
export function createWorkBuddyProxyHandler(
  options: WorkBuddyProxyOptions,
  now: () => number = Date.now,
): (request: Request) => Promise<Response> {
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
      if (url.pathname !== `${prefix}/chat/completions`) {
        /* 绘图请求会打到这儿：说人话，别让 omp 把裸 404 当成网络故障 */
        if (url.pathname.startsWith(`${prefix}/images/`)) {
          return failure(400, 'WorkBuddy 反代只提供对话，不提供绘图', 'images_not_supported')
        }
        return failure(404, 'not found', 'not_found')
      }
      return await handleChat(request, options, upstream, now)
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
