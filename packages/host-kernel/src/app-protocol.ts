import path from 'node:path'
import { safePathSegments } from './url-segments'

/*
 * 应用外壳协议 poietica-app://shell/…（性能审查 P-06）。安装版以前用 loadFile 从 file:// 加载渲染进程，
 * 而 Chromium 默认只给 http(s) 开 V8 代码缓存，每次启动都要把首屏的几 MB 脚本重新编译一遍；自定义协议
 * 注册时带 standard + codeCache，第二次启动起就能直接用缓存（VS Code 的 vscode-file:// 同理）。
 * 与 poietica-asset 分开：应用外壳与用户资产是两个信任域。处理器只做「把 URL 安全地映射到 rendererDir
 * 里的文件」，读文件由调用方注入（安装版是 net.fetch(file://…)，能读 asar），测试里换成假的。
 */

export const APP_SCHEME = 'poietica-app'
export const APP_HOST = 'shell'
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`

/** 注册特权时用：standard + codeCache 缺一不可。 */
export const APP_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  codeCache: true,
} as const

export type FetchFile = (absolutePath: string) => Promise<Response>

export function createAppProtocolHandler(
  rendererDir: string,
  fetchFile: FetchFile,
): (request: Request) => Promise<Response> {
  const root = path.resolve(rendererDir)
  return async (request) => {
    if (request.method !== 'GET') return new Response(null, { status: 405 })
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response(null, { status: 400 })
    }
    if (url.hostname !== APP_HOST) return new Response(null, { status: 404 })
    const segments = safePathSegments(url.pathname)
    if (segments === undefined) return new Response(null, { status: 400 })
    if (segments.length === 0) return new Response(null, { status: 404 })
    const full = path.join(root, ...segments)
    /* 段检查之外再兜一层：拼出来的路径必须仍在 rendererDir 之内（盘符、UNC 之类的意外都挡在这） */
    const relative = path.relative(root, full)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return new Response(null, { status: 400 })
    let response: Response
    try {
      response = await fetchFile(full)
    } catch {
      return new Response(null, { status: 404 })
    }
    const headers = new Headers(response.headers)
    headers.set('X-Content-Type-Options', 'nosniff')
    return new Response(response.body, { status: response.status, headers })
  }
}
