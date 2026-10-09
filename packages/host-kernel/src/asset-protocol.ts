import { AppError, type Logger, SystemErrorCode } from '@poietica/foundation'

export const ASSET_SCHEME = 'poietica-asset'

/** 处理器收到去掉 scheme 与 host 后的路径段（已 decodeURIComponent），返回 Response。抛错 → 500。 */
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
      const segments = url.pathname
        .split('/')
        .filter((s) => s.length > 0)
        .map((s) => decodeURIComponent(s))
      if (segments.some((s) => s === '..' || s.includes('/') || s.includes('\\'))) {
        return new Response(null, { status: 400 })
      }
      try {
        const res = await entry.handler(segments, request)
        res.headers.set('X-Content-Type-Options', 'nosniff')
        res.headers.set('Cache-Control', 'private, max-age=31536000, immutable')
        return res
      } catch (e) {
        logger.error('asset handler failed', { host: url.hostname, error: String(e) })
        return new Response(null, { status: 500 })
      }
    },
  }
}
