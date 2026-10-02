import { Readable } from 'node:stream'

/*
 * poietica-asset:// 的应答端：渲染层 <img> 的预览字节从这里出。
 *
 * 地址形状的正本是 crates/asset/src/delivery.rs 的 asset_protocol_url：
 *   poietica-asset://asset/<sessionToken>/<contentHash>
 *
 * **字节不在磁盘上。** 图片进门时进的是原生侧的内存注册表（crates/asset/src/intake.rs 的
 * commit 只给 ImportedKind::File 落盘；发送那一刻才由
 * apps/desktop/native/src/conversation/attachment.rs 搬进附件根）。所以这个处理器收的是
 * 一个取字节的口子，不是数据根：按 <dataRoot>/attachments/<hash 前两位>/<hash> 去读文件
 * 那条路上什么也没有，表现就是每一张图都 404。
 *
 * Range 必须自己切：字节拿到手就是一整份，<video>/<audio> 的 seek 全靠 206。
 */

/** 取一份资产的字节。 */
export interface AssetByteSource {
  /**
   * 取不到时分两种：资产不在了（没进过门、或已被 asset_remove 放掉）交回 null；
   * 宿主自己坏了就抛。两者的协议应答不同 —— 404 与 500 混在一个码里，
   * 排查时会朝错的方向找。
   */
  read(
    sessionToken: string,
    assetToken: string,
  ): Promise<{ readonly contentType: string; readonly bytes: Buffer } | null>
}

/* 摘要形状与 crates/asset/src/formats.rs 的 is_content_hash 同一条：64 位小写十六进制。 */
const CONTENT_HASH = /^[0-9a-f]{64}$/

/** 令牌形状与 crates/asset/src/identity.rs 的 validate_token 同一条。 */
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/

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

/** 地址解析：形状不对交回 null，调用方据此回 400。 */
function addressOf(request: Request): { sessionToken: string; assetToken: string } | null {
  const url = new URL(request.url)

  if (url.search.length > 0) {
    return null
  }

  const components = url.pathname.split('/').filter((component) => component.length > 0)

  if (url.hostname !== 'asset' || components.length !== 2) {
    return null
  }

  const [sessionToken = '', assetToken = ''] = components

  if (!TOKEN.test(sessionToken) || !CONTENT_HASH.test(assetToken)) {
    return null
  }

  return { sessionToken, assetToken }
}

/*
 * 主进程的 router 在失败时抛的是挂着 problem 的 Error（见 ipc-router.ts 的 failure）。
 * 认的是码不是文案：userMessageKey 随语言变，码不随。
 */
function isMissing(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) {
    return false
  }

  const problem = Reflect.get(cause, 'problem')

  return (
    typeof problem === 'object' &&
    problem !== null &&
    Reflect.get(problem, 'code') === 'resourceMissing'
  )
}

/** 一份字节的公共头。身份是内容摘要，同一条地址的字节永远不会变。 */
function headersFor(contentType: string, length: number): Record<string, string> {
  return {
    'content-type': contentType,
    'content-length': String(length),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=31536000, immutable',
  }
}

export function createAssetProtocolHandler(
  source: AssetByteSource,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const address = addressOf(request)

    if (address === null) {
      return new Response(null, { status: 400 })
    }

    let asset: { readonly contentType: string; readonly bytes: Buffer } | null

    try {
      asset = await source.read(address.sessionToken, address.assetToken)
    } catch (cause) {
      /*
       * 资产不在与宿主坏了分开：原生按 problem 的码回话（没这条资产是
       * resourceMissing / 404，别的都是 500）。这里只认码，不认文案。
       */
      if (isMissing(cause)) {
        return new Response(null, { status: 404 })
      }

      console.error('[Poietica] 资产字节未能取回', cause)

      return new Response(null, { status: 500 })
    }

    if (asset === null) {
      return new Response(null, { status: 404 })
    }

    const size = asset.bytes.byteLength
    const range = requestedRange(request.headers.get('range') ?? '', size)
    /* ReadableStream 在 node:stream 与 DOM 里各有一份类型声明，运行时是同一个对象：
       Response 直接收得下，断言只是让编译器相信这件事。 */
    const body = (bytes: Buffer): BodyInit => Readable.toWeb(Readable.from(bytes)) as BodyInit

    if (range === null) {
      return new Response(body(asset.bytes), {
        status: 200,
        headers: headersFor(asset.contentType, size),
      })
    }

    const slice = asset.bytes.subarray(range.start, range.end + 1)

    return new Response(body(slice), {
      status: 206,
      headers: {
        ...headersFor(asset.contentType, slice.byteLength),
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
      },
    })
  }
}
