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
   *
   * range 缺省即整份。**必须由调用方在取之前给出**：注册表里那份是整份，
   * 取回来再切等于 Range 请求也要付整份的价（实测 4 MiB 资产取 1 KiB 147 ms，
   * 取整份 180 ms）—— 切片的决定要在字节被编码之前做。
   */
  read(
    sessionToken: string,
    assetToken: string,
    range?: { readonly start: number; readonly length: number },
  ): Promise<{
    readonly contentType: string
    readonly bytes: Buffer
    /** 整份资产的长度；bytes 只是被要的那一段。 */
    readonly totalLength: number
  } | null>
}

/* 摘要形状与 crates/asset/src/formats.rs 的 is_content_hash 同一条：64 位小写十六进制。 */
const CONTENT_HASH = /^[0-9a-f]{64}$/

/** 令牌形状与 crates/asset/src/identity.rs 的 validate_token 同一条。 */
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/

/*
 * 只认单段 range（bytes=start-end / bytes=start- / bytes=-suffix），浏览器发的就是这几种。
 *
 * 解出来的形状**不含长度**：起点与终点要先于取字节知道，切片才能发生在原生侧编码之前。
 * 后缀式（bytes=-N）是唯一必须知道总长的形状，它退化成「先取整份再切」—— 浏览器
 * 基本不发它，而正确性优先于这一档的省。
 */
type RequestedRange =
  | { readonly kind: 'span'; readonly start: number; readonly end: number | null }
  | { readonly kind: 'suffix'; readonly length: number }

function parseRange(header: string): RequestedRange | null {
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

    return suffix > 0 ? { kind: 'suffix', length: suffix } : null
  }

  const start = Number(rawStart)
  const end = rawEnd === '' ? null : Number(rawEnd)

  /* end < start 是畸形头，按「没有 Range」处理（老行为）。 */
  return end !== null && end < start ? null : { kind: 'span', start, end }
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

    /*
     * Range 头要先于取字节解析：切片必须发生在原生侧编码之前，否则一次 seek
     * 会付整份资产的价（见 AssetByteSource.read 的注释）。这里先按「不知道长度」
     * 解一次 —— 后缀式（bytes=-N）要等拿到总长才算得出起点，所以它分两步：
     * 先只认 start-end / start-，拿到 totalLength 后再补后缀式。
     */
    const wanted = parseRange(request.headers.get('range') ?? '')

    let asset: {
      readonly contentType: string
      readonly bytes: Buffer
      readonly totalLength: number
    } | null

    try {
      asset = await source.read(
        address.sessionToken,
        address.assetToken,
        /* 后缀式算不出起点，只能取整份 —— 见 parseRange 的注释。 */
        wanted === null || wanted.kind === 'suffix'
          ? undefined
          : {
              start: wanted.start,
              length: (wanted.end ?? Number.MAX_SAFE_INTEGER) - wanted.start + 1,
            },
      )
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

    /* ReadableStream 在 node:stream 与 DOM 里各有一份类型声明，运行时是同一个对象：
       Response 直接收得下，断言只是让编译器相信这件事。 */
    const body = (bytes: Buffer): BodyInit => Readable.toWeb(Readable.from(bytes)) as BodyInit
    const total = asset.totalLength

    if (wanted === null) {
      return new Response(body(asset.bytes), {
        status: 200,
        headers: headersFor(asset.contentType, total),
      })
    }

    /*
     * 起点：区间式取我们自己请求的那个起点；后缀式没有请求区间，由总长反推。
     *
     * 区间式的字节已经是那一段（原生侧切好了）；后缀式交回来的是整份，这里补一刀。
     * 请求区间越界时原生侧交回空段 —— 按 HTTP 那是 416，但浏览器对空段只会放弃这一格，
     * 而 416 会让整张图挂掉，这里保持「交回空 206」的老行为。
     */
    const start = wanted.kind === 'span' ? wanted.start : Math.max(total - wanted.length, 0)
    const bytes = wanted.kind === 'span' ? asset.bytes : asset.bytes.subarray(start)
    const end = start + bytes.byteLength - 1

    return new Response(body(bytes), {
      status: 206,
      headers: {
        ...headersFor(asset.contentType, bytes.byteLength),
        'content-range': `bytes ${start}-${end}/${total}`,
      },
    })
  }
}
