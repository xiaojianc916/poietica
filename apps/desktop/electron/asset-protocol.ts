/*
 * poietica-asset:// 的应答端。
 *
 * 真实布局以 crates/asset 为准，接线时对齐 crate::host::data_root() 与 asset 的 blob 分片规则：
 * 现在按 <dataRoot>/attachments/<contentHash 前两位>/<contentHash> 取文件。
 *
 * Range 必须自己切：net.fetch(pathToFileURL(...)) 转发的是普通 GET，不会替你处理 Range，
 * 而 <video>/<audio> 的 seek 全靠 206。
 */
import { createReadStream, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

const CONTENT_HASH = /^[0-9a-f]{8,128}$/

/** 收得下的格式与 crates/asset/src/formats.rs 的 FORMATS 同表；这张表只管 Content-Type。 */
function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()

  switch (extension) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'bmp':
      return 'image/bmp'
    case 'webp':
      return 'image/webp'
    case 'avif':
      return 'image/avif'
    default:
      return 'text/plain'
  }
}

/** 只认单段 range（bytes=start-end / bytes=start- / bytes=-suffix），浏览器发的就是这几种。 */
function requestedRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())

  if (match === null) {
    return null
  }

  const [, rawStart = '', rawEnd = ''] = match

  if (rawStart === '' && rawEnd === '') {
    return null
  }

  if (rawStart === '') {
    const suffix = Number(rawEnd)

    return suffix > 0 ? { start: Math.max(size - suffix, 0), end: size - 1 } : null
  }

  const start = Number(rawStart)
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)

  return start <= end && start < size ? { start, end } : null
}

function filePath(dataRoot: string, request: Request): string | null {
  const url = new URL(request.url)
  const components = url.pathname.split('/').filter((component) => component.length > 0)

  // poietica-asset://blob/<hash>：host 是 blob，路径只剩哈希一段。
  if (url.hostname !== 'blob' || components.length !== 1) {
    return null
  }

  const hash = components[0] ?? ''

  if (!CONTENT_HASH.test(hash) || url.search.length > 0) {
    return null
  }

  const attachments = resolve(dataRoot, 'attachments')
  const path = resolve(attachments, hash.slice(0, 2), hash)

  // 哈希已限死字符集，这一跳只是不让「拼出来的路径」有机会走出 attachments。
  return path.startsWith(attachments + sep) ? path : null
}

function sizeOf(path: string): number | null {
  try {
    const stats = statSync(path)

    return stats.isFile() ? stats.size : null
  } catch {
    return null
  }
}

export function createAssetProtocolHandler(dataRoot: string): (request: Request) => Response {
  return (request) => {
    const path = filePath(dataRoot, request)

    if (path === null) {
      return new Response(null, { status: 400 })
    }

    const size = sizeOf(path)

    if (size === null) {
      return new Response(null, { status: 404 })
    }

    const type = contentType(path)
    const range = requestedRange(request.headers.get('range') ?? '', size)
    // ReadableStream 在 node:stream 与 DOM 里各有一份类型声明，运行时是同一个对象：
    // Response 直接收得下，断言只是让编译器相信这件事。
    const body = (range === null
      ? Readable.toWeb(createReadStream(path))
      : Readable.toWeb(
          createReadStream(path, { start: range.start, end: range.end }),
        )) as unknown as BodyInit

    if (range === null) {
      return new Response(body, {
        status: 200,
        headers: { 'content-type': type, 'content-length': String(size), 'accept-ranges': 'bytes' },
      })
    }

    return new Response(body, {
      status: 206,
      headers: {
        'content-type': type,
        'content-length': String(range.end - range.start + 1),
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
        'accept-ranges': 'bytes',
      },
    })
  }
}
