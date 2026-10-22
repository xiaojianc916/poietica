import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import type { AssetHandler } from '@poietica/host-kernel'
import { imageMimeOf, type LocatedFile } from '../contract'

/*
 * 工作区图片的字节：poietica-asset://workspace-file/<workspaceId>/<相对路径的各段>。
 *
 * 路径边界不在这里另写一份：每次都问 Core 的 files.locate（字面 + 真实路径两道关，见 core/paths.ts），拿它交回的绝对路径读。
 * 只发图片：这条协议是给 <img> 用的，不是一条能把工作区任意文件读进渲染进程的旁路。
 */

/* SVG 里能带脚本：<img> 里本来不执行，直接导航到这个地址时就会 —— CSP 加 sandbox 一并关掉。 */
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

function codeOf(cause: unknown): string {
  return typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : ''
}

/* Core 拒绝的理由折成状态码：越界 403、不存在（含工作区已被移除）404，其余算故障。 */
function statusOf(cause: unknown): number | null {
  const code = codeOf(cause)
  if (code === 'files.outside_workspace') return 403
  if (code === 'files.not_found' || code.startsWith('workspaces.')) return 404
  return null
}

function imageResponse(located: LocatedFile, mime: string): Response {
  /* 地址里的 ?v= 是修改时间，文件一改界面就换地址；这里仍不让缓存当真 —— 同一毫秒里改两次的那一份不能被旧字节顶替。 */
  const headers = new Headers({ 'Content-Type': mime, 'Cache-Control': 'no-cache' })
  if (mime === 'image/svg+xml') headers.set('Content-Security-Policy', SVG_CSP)
  // 类型上 node:stream/web 的 ReadableStream 与 lib.dom 的不是同一个声明（运行时是同一个东西）。
  return new Response(Readable.toWeb(createReadStream(located.absolutePath)) as unknown as ReadableStream, {
    headers,
  })
}

export function createWorkspaceFileAssetHandler(d: {
  readonly locate: (workspaceId: string, path: string) => Promise<LocatedFile>
  readonly onError: (cause: unknown) => void
}): AssetHandler {
  return async (segments) => {
    const [workspaceId, ...parts] = segments
    if (workspaceId === undefined || parts.length === 0) return new Response(null, { status: 400 })
    const relative = parts.join('/')
    const mime = imageMimeOf(relative)
    if (mime === null) return new Response(null, { status: 415 })
    let located: LocatedFile
    try {
      located = await d.locate(workspaceId, relative)
    } catch (cause: unknown) {
      const status = statusOf(cause)
      if (status === null) d.onError(cause)
      return new Response(null, { status: status ?? 500 })
    }
    if (located.kind !== 'file') return new Response(null, { status: 404 })
    return imageResponse(located, mime)
  }
}
