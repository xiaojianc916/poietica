import { LineSplitter } from '@poietica/foundation'
import type { RpcMessage } from './messages'

export const FRAME_PREFIX = '\x1e'
/**
 * 信封与载荷之间的分隔符（U+001F）。JSON 文本里的控制字符一律要转义（`JSON.stringify` 写成 `\u001f`），
 * 所以它不会出现在任何合法 JSON 里：一帧里**第一个** `\x1f` 必然就是分界。
 */
export const PAYLOAD_SEPARATOR = '\x1f'

/**
 * 一段**未解析**的 JSON 文本（params / result）。Host 是总机：Core → UI 的载荷只转交、从来不看
 * —— 字节解码器（frame-bytes.ts）只解析信封做路由，载荷留成 RawJson、以字符串经 IPC 送达页面，
 * 由页面 JSON.parse（主线程上不再 JSON.parse、不再结构化克隆对象树）。
 * 真要用到值的地方调 {@link jsonValue}。
 */
export class RawJson {
  private parsed: { readonly value: unknown } | undefined

  constructor(readonly text: string) {}

  /** 解析一次并缓存；不合法的 JSON 照常抛 SyntaxError */
  value(): unknown {
    this.parsed ??= { value: JSON.parse(this.text) }
    return this.parsed.value
  }

  /** 兜底：误把含 RawJson 的消息整体 JSON.stringify（日志、Host → Core）时，序列化的是值 */
  toJSON(): unknown {
    return this.value()
  }
}

/** 载荷取值：RawJson 解析成值，其它原样返回。Host 上消费 Core 载荷的地方一律经过它。 */
export function jsonValue(value: unknown): unknown {
  return value instanceof RawJson ? value.value() : value
}

/** 拆出载荷（params / result）；error 很小，留在信封里 */
function split(message: RpcMessage): { readonly head: object; readonly payload: unknown } {
  if ('method' in message) {
    const { params, ...head } = message
    return { head, payload: params }
  }
  if ('result' in message) {
    const { result, ...head } = message
    return { head, payload: result }
  }
  return { head: message, payload: undefined }
}

/**
 * 「信封 + 分隔符 + 载荷」的文本形态：`{"jsonrpc":"2.0","method":"x"}` `\x1f` `{…params…}`。
 * 没有载荷的消息（错误回复、不带 params 的通知）只有信封，也就是一条普通的 JSON-RPC 消息。
 */
export function encodeMessage(message: RpcMessage): string {
  const { head, payload } = split(message)
  const envelope = JSON.stringify(head)
  if (payload === undefined) return envelope
  const body = payload instanceof RawJson ? payload.text : JSON.stringify(payload)
  return body === undefined ? envelope : `${envelope}${PAYLOAD_SEPARATOR}${body}`
}

/**
 * Host → UI 转交 Core 消息时的 IPC 形态：载荷是 RawJson 就拆成「信封对象 + 载荷 JSON 文本」两个参数
 * （`webContents.send(channel, envelope, payloadJson)`）。字符串的结构化克隆是一次 memcpy，到了 preload 跨
 * contextBridge 不拷贝（两个 world 同一个 V8 isolate）。载荷不是 RawJson 时返回 null —— 照旧整条按对象发送。
 * 接收方见 {@link joinRelayParts}。
 */
export function relayParts(message: RpcMessage): readonly [envelope: object, payloadJson: string] | null {
  const { head, payload } = split(message)
  return payload instanceof RawJson ? [head, payload.text] : null
}

/** {@link relayParts} 的逆：信封 + 载荷 JSON 文本 → 消息（在页面里解析载荷） */
export function joinRelayParts(envelope: unknown, payloadJson: string): RpcMessage | DecodeFailure {
  let payload: unknown
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    return BAD
  }
  return assembleMessage(envelope, payload, true)
}

/** Core → Host（stdout）：`\x1e` + 信封 [+ `\x1f` + 载荷] + `\n` */
export function encodeFrame(message: RpcMessage): string {
  return `${FRAME_PREFIX}${encodeMessage(message)}\n`
}
/** Host → Core（stdin）：每行一条完整的 JSON-RPC 消息（这个方向与以前一致；载荷几乎都是小的界面请求） */
export function encodeLine(message: RpcMessage): string {
  return `${JSON.stringify(message)}\n`
}

/** 解码失败。只有下面两个常量实例：按引用判别，不看对端数据里有没有某个键 */
export interface DecodeFailure {
  readonly failure: 'bad' | 'not-jsonrpc'
}
const BAD: DecodeFailure = Object.freeze({ failure: 'bad' })
const NOT_JSONRPC: DecodeFailure = Object.freeze({ failure: 'not-jsonrpc' })

export function isDecodeFailure(value: RpcMessage | DecodeFailure): value is DecodeFailure {
  return value === BAD || value === NOT_JSONRPC
}

/** 解析出的信封 + 载荷 → 消息。载荷归 params（有 method）还是 result（没有 method）由信封决定。 */
export function assembleMessage(head: unknown, payload: unknown, hasPayload: boolean): RpcMessage | DecodeFailure {
  if (typeof head !== 'object' || head === null || Array.isArray(head)) return NOT_JSONRPC
  const envelope = head as Record<string, unknown>
  if (envelope.jsonrpc !== '2.0') return NOT_JSONRPC
  if (hasPayload) envelope['method' in envelope ? 'params' : 'result'] = payload
  return envelope as unknown as RpcMessage
}

/** 文本形态 → 消息（全量解析）。两种形态都认：带 `\x1f` 的拆信封形态、不带的完整 JSON-RPC 消息。 */
export function decodeMessage(text: string): RpcMessage | DecodeFailure {
  const sep = text.indexOf(PAYLOAD_SEPARATOR)
  try {
    if (sep === -1) return assembleMessage(JSON.parse(text), undefined, false)
    return assembleMessage(JSON.parse(text.slice(0, sep)), JSON.parse(text.slice(sep + 1)), true)
  } catch {
    return BAD
  }
}

/** 单帧上限（字符数）。超过即视为对端失控：报一次 `[frame overflow]` 并丢弃到下一个换行 */
export const MAX_FRAME_CHARS = 64 * 1024 * 1024

/**
 * 文本流的增量解码器（全量解析）。requirePrefix=true 认 `\x1e` 帧；false 用于 Core stdin（纯行）。
 * 切行交给 foundation 的 LineSplitter（线性时间、只认 `\n`），这里只管「一行 → 一条消息」。
 * Host 读 Core stdout 不走这里，走字节解码器（`frame-bytes.ts`）：只解析信封，载荷只解成字符串、不解析。
 */
export class FrameDecoder {
  private readonly lines: LineSplitter

  constructor(
    private readonly requirePrefix: boolean,
    private readonly onMessage: (message: RpcMessage) => void,
    private readonly onStray: (text: string) => void,
    maxFrameChars: number = MAX_FRAME_CHARS,
  ) {
    this.lines = new LineSplitter((line) => this.handleLine(line), {
      maxLineLength: maxFrameChars,
      onOverflow: (head) => this.onStray(`[frame overflow] ${head}`),
    })
  }

  push(chunk: string): void {
    this.lines.push(chunk)
  }

  private handleLine(line: string): void {
    if (line.trim() === '') return
    let body = line
    if (this.requirePrefix) {
      const start = line.indexOf(FRAME_PREFIX)
      if (start === -1) {
        this.onStray(line)
        return
      }
      if (start > 0) this.onStray(line.slice(0, start))
      body = line.slice(start + 1)
    }
    const decoded = decodeMessage(body)
    if (isDecodeFailure(decoded)) {
      this.onStray(`${decoded.failure === 'bad' ? '[bad frame]' : '[not jsonrpc]'} ${body.slice(0, 200)}`)
      return
    }
    this.onMessage(decoded)
  }
}
