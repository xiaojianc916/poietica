import { createHash } from 'node:crypto'
import type { Logger } from '@poietica/foundation'
import type { AssetHandler } from '@poietica/host-kernel'
import { FAVICON_ASSET_HOST } from '../contract/entities'

/* 站点图标的唯一取图人。页面通过 page-favicon-updated 报上来的只是「候选地址」—— 外站说了算的任意 URL，
 * 不能原样交给应用界面：界面是特权渲染进程，CSP 只放行受信协议，直连外站要么被静默拦掉（一律地球），
 * 要么放宽 CSP、拿应用自己的会话替网页发请求（越过浏览器分区的 Cookie / 代理 / 证书策略）。
 *
 * 这里的做法与 Chromium 自己的 FaviconDriver 同一思路：
 * - 用**浏览器分区**的会话去取（fetch 由 index.ts 注入），页面本来就能用这个会话访问同样的地址，不新增能力；
 * - 不信 Content-Type，按魔数认格式，只收常见图标格式，单张有上限，超时即弃；
 * - 按内容 sha256 存进内存，以 poietica-asset://browser-favicon/<sha> 交给界面（同一张图只存一份，地址天然不可变）；
 * - 页面没声明图标时补 <origin>/favicon.ico；同一地址并发只取一次，确定的失败记住不再重试。 */

export type FaviconFetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>

export interface FaviconStore {
  /** 按候选顺序取第一张能用的图，返回资源地址；都不行返回 null。不抛错。 */
  resolve(candidates: readonly string[], pageUrl: string | null): Promise<string | null>
  /** 挂到 poietica-asset://browser-favicon/ 下的处理器。 */
  readonly handler: AssetHandler
}

export interface FaviconStoreOptions {
  readonly fetch: FaviconFetch
  readonly logger: Logger
  /** 单张上限，默认 256 KiB（正常图标几 KB，再大就不是图标了）。 */
  readonly maxIconBytes?: number
  /** 内存总预算，默认 8 MiB；超出按最久未用淘汰。 */
  readonly budgetBytes?: number
  readonly timeoutMs?: number
}

export type FaviconMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'image/bmp'
  | 'image/x-icon'
  | 'image/svg+xml'

const MAX_ICON_BYTES = 256 * 1024
const BUDGET_BYTES = 8 * 1024 * 1024
const TIMEOUT_MS = 8000
/** 页面声明的候选最多试这么多张（另加一张 /favicon.ico 兜底）：有的站点一口气声明十几个尺寸。 */
const MAX_CANDIDATES = 4
const MEMO_CAP = 512
const SHA = /^[a-f0-9]{64}$/
/** SVG 在 <img> 里本就不跑脚本、不取子资源；直接打开这个地址时再用 CSP 兜一层。 */
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'"
const ASSET_PREFIX = `poietica-asset://${FAVICON_ASSET_HOST}/`

interface StoredIcon {
  readonly mime: FaviconMime
  readonly bytes: Uint8Array
}

/** 取不到的两种结局：确定的（404、不是图片）记住；暂时的（断网、超时）下次再试。 */
type Outcome = { readonly kind: 'ok'; readonly sha: string } | { readonly kind: 'fail'; readonly final: boolean }

export function faviconAssetUrl(sha: string): string {
  return `${ASSET_PREFIX}${sha}`
}

/** 按魔数认格式；Content-Type 不可信（常见 .ico 被报成 text/plain 或 application/octet-stream）。 */
export function sniffFaviconMime(bytes: Uint8Array): FaviconMime | null {
  const at = (i: number): number => bytes[i] ?? -1
  const ascii = (from: number, text: string): boolean =>
    [...text].every((char, i) => at(from + i) === char.charCodeAt(0))

  if (at(0) === 0x89 && ascii(1, 'PNG')) return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (ascii(0, 'GIF8')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  if (at(0) === 0 && at(1) === 0 && at(2) === 1 && at(3) === 0) return 'image/x-icon'
  if (ascii(0, 'BM')) return 'image/bmp'

  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 1024))
    .replace(/^\uFEFF/u, '')
    .trimStart()

  if (head.startsWith('<') && /<svg[\s>]/iu.test(head) && !/<html[\s>]/iu.test(head)) return 'image/svg+xml'

  return null
}

/** 候选整理：只要 http(s) 与 data:image，去重、限量，末尾补站点根的 /favicon.ico。 */
export function faviconCandidates(candidates: readonly string[], pageUrl: string | null): string[] {
  const out: string[] = []

  for (const raw of candidates) {
    const url = acceptable(raw)

    if (url !== null && !out.includes(url)) out.push(url)
    if (out.length >= MAX_CANDIDATES) break
  }

  const fallback = pageUrl === null ? null : rootFavicon(pageUrl)

  if (fallback !== null && !out.includes(fallback)) out.push(fallback)

  return out
}

function acceptable(raw: string): string | null {
  if (/^data:image\//iu.test(raw)) return raw

  try {
    const parsed = new URL(raw)

    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function rootFavicon(pageUrl: string): string | null {
  try {
    const parsed = new URL(pageUrl)

    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? `${parsed.origin}/favicon.ico` : null
  } catch {
    return null
  }
}

export function createFaviconStore(opts: FaviconStoreOptions): FaviconStore {
  const maxIconBytes = opts.maxIconBytes ?? MAX_ICON_BYTES
  const budgetBytes = opts.budgetBytes ?? BUDGET_BYTES
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  /** sha → 图；Map 的插入序即使用序（读一次就挪到末尾）。 */
  const icons = new Map<string, StoredIcon>()
  /** 候选地址 → sha（成功）或 null（确定失败）。 */
  const memo = new Map<string, string | null>()
  const inflight = new Map<string, Promise<Outcome>>()
  let usedBytes = 0

  function remember(url: string, value: string | null): void {
    memo.delete(url)
    memo.set(url, value)

    while (memo.size > MEMO_CAP) {
      const oldest = memo.keys().next().value

      if (oldest === undefined) break
      memo.delete(oldest)
    }
  }

  function store(mime: FaviconMime, bytes: Uint8Array): string {
    const sha = createHash('sha256').update(bytes).digest('hex')

    if (!icons.has(sha)) {
      icons.set(sha, { mime, bytes })
      usedBytes += bytes.byteLength

      while (usedBytes > budgetBytes && icons.size > 1) {
        const [oldest, icon] = icons.entries().next().value ?? []

        if (oldest === undefined || icon === undefined) break
        icons.delete(oldest)
        usedBytes -= icon.bytes.byteLength
      }
    }

    return sha
  }

  function accept(bytes: Uint8Array | null): Outcome {
    if (bytes === null || bytes.byteLength === 0) return { kind: 'fail', final: true }

    const mime = sniffFaviconMime(bytes)

    return mime === null ? { kind: 'fail', final: true } : { kind: 'ok', sha: store(mime, bytes) }
  }

  async function download(url: string): Promise<Outcome> {
    if (url.toLowerCase().startsWith('data:')) return accept(decodeDataUrl(url, maxIconBytes))

    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    try {
      const res = await opts.fetch(url, { signal: controller.signal })

      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)

        // 4xx 是站点明确说没有；5xx 可能只是一时故障。
        return { kind: 'fail', final: res.status < 500 }
      }

      return accept(await readCapped(res, maxIconBytes))
    } catch (cause) {
      opts.logger.debug('browser favicon fetch failed', { url, error: String(cause) })

      return { kind: 'fail', final: false }
    } finally {
      clearTimeout(timer)
    }
  }

  async function load(url: string): Promise<string | null> {
    const known = memo.get(url)

    if (known === null) return null
    if (known !== undefined && icons.has(known)) return known

    let pending = inflight.get(url)

    if (pending === undefined) {
      pending = download(url).finally(() => {
        inflight.delete(url)
      })
      inflight.set(url, pending)
    }

    const outcome = await pending

    if (outcome.kind === 'ok') {
      remember(url, outcome.sha)

      return outcome.sha
    }

    if (outcome.final) remember(url, null)

    return null
  }

  return {
    async resolve(candidates, pageUrl) {
      for (const url of faviconCandidates(candidates, pageUrl)) {
        const sha = await load(url)

        if (sha !== null) return faviconAssetUrl(sha)
      }

      return null
    },

    handler(segments) {
      const [sha] = segments

      if (segments.length !== 1 || sha === undefined || !SHA.test(sha)) {
        return new Response(null, { status: 400 })
      }

      const icon = icons.get(sha)

      if (icon === undefined) return new Response(null, { status: 404 })

      icons.delete(sha)
      icons.set(sha, icon)

      const headers = new Headers({ 'Content-Type': icon.mime })

      if (icon.mime === 'image/svg+xml') headers.set('Content-Security-Policy', SVG_CSP)

      return new Response(new Blob([icon.bytes as Uint8Array<ArrayBuffer>], { type: icon.mime }), { headers })
    },
  }
}

/** 读响应体，超过上限当场放弃（不信 Content-Length，但它先说超了就不必读）。 */
async function readCapped(res: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length') ?? Number.NaN)

  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => undefined)

    return null
  }

  if (res.body === null) return null

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) break

    total += value.byteLength

    if (total > limit) {
      await reader.cancel().catch(() => undefined)

      return null
    }

    chunks.push(value)
  }

  const out = new Uint8Array(total)
  let offset = 0

  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }

  return out
}

function decodeDataUrl(url: string, limit: number): Uint8Array | null {
  const comma = url.indexOf(',')

  if (comma === -1) return null

  const meta = url.slice(5, comma)
  const payload = url.slice(comma + 1)

  try {
    const bytes = /;base64$/iu.test(meta)
      ? Uint8Array.from(Buffer.from(payload, 'base64'))
      : new TextEncoder().encode(decodeURIComponent(payload))

    return bytes.byteLength > limit ? null : bytes
  } catch {
    return null
  }
}
