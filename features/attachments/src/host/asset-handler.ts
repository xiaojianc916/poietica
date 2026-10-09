import { createReadStream, existsSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { AssetHandler } from '@poietica/host-kernel'

/*
 * 07 页 §4D 的协议处理器，抽成可单测的工厂（§4D 把它内联在 setup 里；抽出这一段不改变行为，
 * 只是让“非法 sha → 400 / 找不到 → 404 / 未知 mime → octet-stream / svg 带 CSP”这几条能被
 * 直接测到）。host 模块在 setup 里用 ctx.layout.attachmentsDir 调它注册。
 */

const SHA = /^[a-f0-9]{64}$/
/** 只有这几类内联渲染；其余一律 application/octet-stream（浏览器不会内联渲染） */
const INLINE_MIME = /^(image\/(png|jpeg|gif|webp|bmp|svg\+xml)|application\/pdf|text\/plain)$/

export function createAttachmentAssetHandler(deps: { readonly attachmentsDir: string }): AssetHandler {
  return (segments, request) => {
    const [sha] = segments
    if (segments.length !== 1 || sha === undefined || !SHA.test(sha)) {
      return new Response(null, { status: 400 })
    }
    // 路径由 Host 自己拼，只接受 64 位十六进制 sha：无法用 .. 逃出附件目录
    const file = path.join(deps.attachmentsDir, sha.slice(0, 2), sha)
    if (!existsSync(file)) return new Response(null, { status: 404 })
    const mime = new URL(request.url).searchParams.get('mime') ?? ''
    const type = INLINE_MIME.test(mime) ? mime : 'application/octet-stream'
    const headers = new Headers({ 'Content-Type': type })
    // SVG 里的脚本能执行：额外加一条 CSP
    if (type === 'image/svg+xml') {
      headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    }
    // 类型上 node:stream/web 的 ReadableStream 与 lib.dom 的不是同一个声明（运行时是同一个东西）
    return new Response(Readable.toWeb(createReadStream(file)) as unknown as ReadableStream, { headers })
  }
}
