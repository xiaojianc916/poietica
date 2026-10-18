import { AppError, type Logger, SystemErrorCode } from '@poietica/foundation'
import { safePathSegments } from './url-segments'

export const ASSET_SCHEME = 'poietica-asset'

/**
 * 内容寻址资产（附件、媒体 blob、站点图标）的默认缓存策略：地址里带着内容的哈希，同址永远同字节。
 * 只给处理器没自己表态的 2xx 加；内容会随应用版本变的处理器（例如组件外壳）自己写 Cache-Control。
 */
const IMMUTABLE = 'private, max-age=31536000, immutable'

/**
 * 处理器收到去掉 scheme 与 host 后的路径段（已解码、已挡掉 `.` `..` 与分隔符），返回 Response。抛错 → 500。
 * 缓存策略归处理器：返回的响应带了 Cache-Control 就照用；没带时 2xx 按内容寻址处理（IMMUTABLE），其余一律 no-store ——
 * 「还没取到」的 404 不能被当成一年有效的答案缓存下来。
 */
export type AssetHandler = (segments: readonly string[], request: Request) => Promise<Response> | Response

export interface AssetDispatcher {
  register(moduleId: string, host: string, handler: AssetHandler): void
  dispatch(request: Request): Promise<Response>
}

const HOST = /^[a-z][a-z0-9-]*$/

export function createAssetDispatcher(logger: Logger): AssetDispatcher {
  const handlers = new Map<string, { moduleId: string; handler: AssetHandler }>()
  return {
    register(moduleId, host, handler) {
      if (!HOST.test(host)) throw new AppError(SystemErrorCode.invalidParams, `asset host 不合法：${host}`)
      const prev = handlers.get(host)
      if (prev !== undefined) {
        throw new AppError(SystemErrorCode.conflict, `asset host ${host} 已被 ${prev.moduleId} 注册`)
      }
      handlers.set(host, { moduleId, handler })
    },
    async dispatch(request) {
      if (request.method !== 'GET') return new Response(null, { status: 405 })
      let url: URL
      try {
        url = new URL(request.url)
      } catch {
        return new Response(null, { status: 400 })
      }
      const entry = handlers.get(url.hostname)
      if (entry === undefined) return new Response(null, { status: 404 })
      const segments = safePathSegments(url.pathname)
      if (segments === undefined) return new Response(null, { status: 400 })
      try {
        return withAssetHeaders(await entry.handler(segments, request))
      } catch (e) {
        logger.error('asset handler failed', { host: url.hostname, error: String(e) })
        return new Response(null, { status: 500 })
      }
    },
  }
}

/*
 * 复制一份再加头，不原地改：fetch() / Response.redirect() 给的响应头是不可变的，原地 set 会抛 TypeError，
 * 一个本来成功的响应就变成了 500。
 */
function withAssetHeaders(res: Response): Response {
  const headers = new Headers(res.headers)
  headers.set('X-Content-Type-Options', 'nosniff')
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', res.ok ? IMMUTABLE : 'no-store')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}
