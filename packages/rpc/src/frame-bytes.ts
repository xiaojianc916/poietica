import { assembleMessage, isDecodeFailure, RawJson } from './frame'
import type { RpcMessage } from './messages'

const NL = 0x0a
const CR = 0x0d
const PREFIX = 0x1e
const SEPARATOR = 0x1f
const SAMPLE_BYTES = 200

/**
 * 单帧上限（字节）。与文本解码器的 64M 字符同一个内存量级：64M 个 UTF-16 码元 = 128MB。
 * 超过即视为对端失控：报一次 `[frame overflow]` 并丢弃到下一个换行。
 */
export const MAX_FRAME_BYTES = 128 * 1024 * 1024

/** 跨块的帧进入「载荷态」后的状态：信封已解析，载荷随块到达逐块解码 */
interface PayloadState {
  readonly envelope: unknown
  readonly decoder: TextDecoder
  readonly parts: string[]
  /** 行首样本（`[frame overflow]` 用）与前缀之后的样本（`[not jsonrpc]` 用），与整行解码时的口径一致 */
  readonly lineSample: string
  readonly frameSample: string
}

/**
 * Host 读 Core stdout 的解码器：**按字节**切帧，只解析信封，载荷留成 {@link RawJson}（未解析的 JSON 文本）。
 *
 * 旧做法是 `stdout.setEncoding('utf8')` + 文本解码器：每一帧在 Electron 主线程上经 StringDecoder 解 UTF-8、
 * 拼行、整段 JSON.parse，再交给 IPC 结构化克隆一棵对象树 —— 而 Host 只需要信封里的 id / method。这里：
 * - 在字节上找 `\n`（Buffer 的 indexOf 是 memchr）、找 `\x1e` 与第一个 `\x1f`，只 JSON.parse 信封那几十个字节；
 * - 载荷只做 UTF-8 → 字符串（TextDecoder，simdutf），不解析：转交给 UI 时字符串的结构化克隆是一次 memcpy；
 * - 跨多个块的大帧，信封一到就进入载荷态，之后每到一块就解码一块（流式 TextDecoder），不在行尾先把几 MB
 *   字节拼起来再一次性解码 —— 主线程上不出现与帧大小成正比的整块拷贝 + 整段解码。
 *
 * 语义与文本解码器一致：只认 `\n`、去掉行尾 `\r`、空白行忽略、前缀之前的杂散文本与非帧行交给 onStray、
 * 坏帧报 `[bad frame]`、非 JSON-RPC 报 `[not jsonrpc]`、超长报一次 `[frame overflow]` 并丢弃到下一个换行。
 * 不带 `\x1f` 的帧按完整 JSON-RPC 消息全量解析（没有载荷的消息，以及旧版 Core 的帧）。
 * 诊断样本（≤200 字节）取自当时手上的字节：跨块大帧的坏信封在信封到达时就报，样本可能短于整行解码时
 * （以前的 `[frame overflow]` 样本同样随切块而异）。
 */
export class FrameByteDecoder {
  /** 当前行里还没进入载荷态的字节（行首起）；`prefixAt` 是其中 `\x1e` 的位置（-1：还没见到） */
  private head: Uint8Array[] = []
  private headLength = 0
  private prefixAt = -1
  private payload: PayloadState | null = null
  /** 超长判断用 */
  private lineLength = 0
  /** 正在丢弃一条超长或坏掉的行，直到下一个换行 */
  private discarding = false

  constructor(
    private readonly onMessage: (message: RpcMessage) => void,
    private readonly onStray: (text: string) => void,
    private readonly maxFrameBytes: number = MAX_FRAME_BYTES,
  ) {}

  /**
   * 生产环境的 chunk 是 Node 的 Buffer：`indexOf` 走的是 Buffer 自己的实现（memchr），不是逐元素比较。
   * 这个文件只用 Uint8Array 的接口，所以 rpc 包不必引入 Node 的类型。
   */
  push(input: Uint8Array | string): void {
    const chunk = typeof input === 'string' ? utf8Encoder.encode(input) : input
    let start = 0
    let nl = chunk.indexOf(NL)
    while (nl !== -1) {
      const piece = chunk.subarray(start, nl)
      if (this.lineLength === 0 && !this.discarding) {
        // 整行都在这一块里（绝大多数帧）：直接按整行处理，不经过任何缓冲
        if (piece.length > this.maxFrameBytes) this.onStray(`[frame overflow] ${sample(piece, 0, piece.length)}`)
        else this.handleLine(piece)
      } else {
        this.feed(piece)
        this.endLine()
      }
      start = nl + 1
      nl = chunk.indexOf(NL, start)
    }
    if (start < chunk.length) this.feed(start === 0 ? chunk : chunk.subarray(start))
  }

  /** 当前行的一段（不含换行） */
  private feed(piece: Uint8Array): void {
    if (this.discarding || piece.length === 0) return
    if (this.lineLength + piece.length > this.maxFrameBytes) {
      this.overflow(piece)
      return
    }
    this.lineLength += piece.length
    if (this.payload !== null) {
      this.payload.parts.push(this.payload.decoder.decode(piece, { stream: true }))
      return
    }
    const base = this.headLength
    this.head.push(piece)
    this.headLength += piece.length
    let from = 0
    if (this.prefixAt === -1) {
      const at = piece.indexOf(PREFIX)
      if (at === -1) return
      this.prefixAt = base + at
      from = at + 1
    }
    const sep = piece.indexOf(SEPARATOR, from)
    if (sep !== -1) this.enterPayload(base + sep)
  }

  /** 信封完整了（`\x1f` 已到）：解析信封，之后的字节按载荷逐块解码 */
  private enterPayload(sepAt: number): void {
    const bytes = this.head.length === 1 ? (this.head[0] as Uint8Array) : concat(this.head, this.headLength)
    const prefixAt = this.prefixAt
    this.head = []
    this.headLength = 0
    this.prefixAt = -1
    const frameSample = sample(bytes, prefixAt + 1, bytes.length)
    if (prefixAt > 0) this.onStray(text(bytes, 0, prefixAt))
    let envelope: unknown
    try {
      envelope = JSON.parse(text(bytes, prefixAt + 1, sepAt))
    } catch {
      this.onStray(`[bad frame] ${frameSample}`)
      this.discarding = true
      return
    }
    const decoder = new TextDecoder()
    this.payload = {
      envelope,
      decoder,
      parts: [decoder.decode(bytes.subarray(sepAt + 1), { stream: true })],
      lineSample: sample(bytes, 0, bytes.length),
      frameSample,
    }
  }

  private endLine(): void {
    const payload = this.payload
    const head = this.head
    const headLength = this.headLength
    const discarding = this.discarding
    this.reset()
    if (discarding) return
    if (payload === null) {
      this.handleLine(head.length === 1 ? (head[0] as Uint8Array) : concat(head, headLength))
      return
    }
    payload.parts.push(payload.decoder.decode())
    let json = payload.parts.join('')
    if (json.endsWith('\r')) json = json.slice(0, -1)
    const message = assembleMessage(payload.envelope, new RawJson(json), true)
    if (isDecodeFailure(message)) this.onStray(`[not jsonrpc] ${payload.frameSample}`)
    else this.onMessage(message)
  }

  /** 一整行（已在一块连续的字节里） */
  private handleLine(line: Uint8Array): void {
    const end = line.length > 0 && line[line.length - 1] === CR ? line.length - 1 : line.length
    if (isBlank(line, end)) return
    const start = line.indexOf(PREFIX)
    if (start === -1 || start >= end) {
      this.onStray(text(line, 0, end))
      return
    }
    if (start > 0) this.onStray(text(line, 0, start))
    const sep = line.indexOf(SEPARATOR, start + 1)
    const hasPayload = sep !== -1 && sep < end
    let head: unknown
    try {
      head = JSON.parse(text(line, start + 1, hasPayload ? sep : end))
    } catch {
      this.onStray(`[bad frame] ${sample(line, start + 1, end)}`)
      return
    }
    const message = assembleMessage(head, hasPayload ? new RawJson(text(line, sep + 1, end)) : undefined, hasPayload)
    if (isDecodeFailure(message)) {
      this.onStray(`[not jsonrpc] ${sample(line, start + 1, end)}`)
      return
    }
    this.onMessage(message)
  }

  /** 报告一次超长并进入丢弃态；样本取自行首 */
  private overflow(tail: Uint8Array): void {
    const first = this.head[0] ?? tail
    this.onStray(`[frame overflow] ${this.payload?.lineSample ?? sample(first, 0, first.length)}`)
    this.reset()
    this.discarding = true
  }

  private reset(): void {
    this.head = []
    this.headLength = 0
    this.prefixAt = -1
    this.payload = null
    this.lineLength = 0
    this.discarding = false
  }
}

const utf8Decoder = new TextDecoder()
const utf8Encoder = new TextEncoder()

function text(bytes: Uint8Array, from: number, to: number): string {
  return utf8Decoder.decode(bytes.subarray(from, to))
}

function sample(bytes: Uint8Array, from: number, end: number): string {
  return text(bytes, from, Math.min(end, from + SAMPLE_BYTES))
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** 与 `line.trim() === ''` 同口径（只看 ASCII 空白：帧与杂散输出都不会以别的空白开头） */
function isBlank(line: Uint8Array, end: number): boolean {
  for (let i = 0; i < end; i++) {
    const b = line[i]
    if (b !== 0x20 && b !== 0x09 && b !== 0x0b && b !== 0x0c && b !== CR) return false
  }
  return true
}
