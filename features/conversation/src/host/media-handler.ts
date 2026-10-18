import { createReadStream, existsSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { AssetHandler } from '@poietica/host-kernel'

/*
 * 时间线图片：poietica-asset://media/<sha256>?mime=<类型>。字节就是 omp blob 目录里以 sha256 命名的那个文件
 * （Core 发出地址之前已保证它在，见 engine-omp 的 session/media-store.ts）。
 *
 * - 只认 64 位小写十六进制：路径由 Host 自己拼，无法用 .. 逃出 blob 目录；
 * - 只读、内容寻址：同一个地址永远是同一份字节，资源协议的 immutable 缓存正好成立；
 * - mime 只放行模型能收的几种位图；别的（包括 svg）一律 octet-stream —— <img> 不会把它当文档执行。
 */

const SHA = /^[a-f0-9]{64}$/
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/

export function createMediaAssetHandler(deps: { readonly blobsDir: string }): AssetHandler {
  return (segments, request) => {
    const [sha] = segments
    if (segments.length !== 1 || sha === undefined || !SHA.test(sha)) return new Response(null, { status: 400 })
    const file = path.join(deps.blobsDir, sha)
    if (!existsSync(file)) return new Response(null, { status: 404 })
    const mime = new URL(request.url).searchParams.get('mime') ?? ''
    const headers = new Headers({ 'Content-Type': IMAGE_MIME.test(mime) ? mime : 'application/octet-stream' })
    // 类型上 node:stream/web 的 ReadableStream 与 lib.dom 的不是同一个声明（运行时是同一个东西）。
    return new Response(Readable.toWeb(createReadStream(file)) as unknown as ReadableStream, { headers })
  }
}
