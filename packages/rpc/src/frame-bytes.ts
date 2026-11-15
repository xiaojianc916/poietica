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

/**
 * Host 读 Core stdout 的解码器：**按字节**切帧，只解析信封，载荷留成 {@link RawJson}。
 * 旧做法整帧解 UTF-8、拼行、JSON.parse、再结构化克隆一棵对象树，而 Host 只需要信封里的 id / method：
 * 这里在字节上找 `\n` 与 `\x1e`/`\x1f`、只 parse 信封那几十个字节；载荷只做 UTF-8 → 字符串
 * （转交 UI 时字符串的克隆是一次 memcpy）。
 *
 * 跨块的行（整帧不在一个 chunk 里）把字节按 chunk 存视图，**换行到了才解一次**：
 * 从前是每到一块就 streaming decode 一段、再 `parts.join('')` 拼起来，32MB 的整页快照因此要解 N 次、
 * 再付一次全文拷贝；现在同样的帧只解一次（`decode` 一次 simdutf 遍历），信封仍在那之前就 parse 出来做路由。
 *
 * 语义与文本解码器一致：只认 `\n`、去 `\r`、空白行忽略、杂散与非帧行交 onStray、
 * 坏帧 `[bad frame]`、非 JSON-RPC `[not jsonrpc]`、超长报一次 `[frame overflow]` 并丢弃到下一换行；
 * 不带 `\x1f` 的帧按完整 JSON-RPC 消息全量解析。诊断样本（≤200 字节）取自**当时手上**的字节 ——
 * 坏信封在分隔符到达时就用那一段报，之后再丢弃到行尾。
 */
export class FrameByteDecoder {
  /** 本行到目前为止的字节（行首起），按 chunk 存视图；换行时才拼接 */
  private parts: Uint8Array[] = []
  private length = 0
  /** `\x1e` 的字节位置（-1：还没见到） */
  private prefixAt = -1
  /** `\x1f` 的字节位置（-1：这一帧没有载荷，或还没见到） */
  private sepAt = -1
  /** 分隔符之前那份信封（已 parse）；有载荷时才用得上 */
  private envelope: unknown = undefined
  /** 行首样本（`[frame overflow]` 用）与前缀之后的样本（`[not jsonrpc]` 用），与整行解码时的口径一致 */
  private lineSample: string | undefined
  private frameSample: string | undefined
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
      if (this.length === 0 && !this.discarding) {
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
    if (this.length + piece.length > this.maxFrameBytes) {
      this.overflow(piece)
      return
    }
    const base = this.length
    this.length += piece.length
    this.parts.push(piece)
    /* 信封已到手：这一行只剩载荷字节，扫都不用再扫 */
    if (this.sepAt !== -1) return
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

  /**
   * 分隔符到了：这一帧往后全是载荷。信封现在就 parse（Host 只认它做路由），载荷字节留在 parts 里，
   * 换行到了再整段解一次 —— 比起逐块 streaming decode + join，省掉 N 次解码与一次全文拼接。
   */
  private enterPayload(sepAt: number): void {
    this.sepAt = sepAt
    const prefixAt = this.prefixAt
    this.prefixAt = -1
    this.frameSample = rangeSample(this.parts, prefixAt + 1, this.length)
    this.lineSample = rangeSample(this.parts, 0, this.length)
    if (prefixAt > 0) this.onStray(rangeText(this.parts, 0, prefixAt))
    let envelope: unknown
    try {
      /* 只解信封那几十个字节：整行还要等换行才解，这里不复制 32MB 的载荷 */
      envelope = JSON.parse(rangeText(this.parts, prefixAt + 1, sepAt))
    } catch {
      this.onStray(`[bad frame] ${this.frameSample}`)
      this.discarding = true
      this.parts = []
      this.length = 0
      return
    }
    this.envelope = envelope
  }

  private endLine(): void {
    const parts = this.parts
    const length = this.length
    const sepAt = this.sepAt
    const envelope = this.envelope
    const frameSample = this.frameSample
    const discarding = this.discarding
    this.reset()
    if (discarding) return
    const bytes = parts.length === 1 ? (parts[0] as Uint8Array) : concat(parts, length)
    if (sepAt === -1) {
      this.handleLine(bytes)
      return
    }
    const end = bytes.length > 0 && bytes[bytes.length - 1] === CR ? bytes.length - 1 : bytes.length
    const message = assembleMessage(envelope, new RawJson(text(bytes, sepAt + 1, end)), true)
    if (isDecodeFailure(message)) this.onStray(`[not jsonrpc] ${frameSample ?? ''}`)
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
    const first = this.parts[0] ?? tail
    this.onStray(`[frame overflow] ${this.lineSample ?? sample(first, 0, first.length)}`)
    this.reset()
    this.discarding = true
  }

  private reset(): void {
    this.parts = []
    this.length = 0
    this.prefixAt = -1
    this.sepAt = -1
    this.envelope = undefined
    this.lineSample = undefined
    this.frameSample = undefined
    this.discarding = false
  }
}

const utf8Decoder = new TextDecoder()
const utf8Encoder = new TextEncoder()

function text(bytes: Uint8Array, from: number, to: number): string {
  return to <= from ? '' : utf8Decoder.decode(bytes.subarray(from, to))
}

function sample(bytes: Uint8Array, from: number, end: number): string {
  return text(bytes, from, Math.min(end, from + SAMPLE_BYTES))
}

/** parts 里 [from, to) 这段字节的文本：只在信封与诊断样本上用，不为此复制整行 */
function rangeText(parts: readonly Uint8Array[], from: number, to: number): string {
  if (to <= from) return ''
  const only = parts.length === 1 ? parts[0] : undefined
  if (only !== undefined) return utf8Decoder.decode(only.subarray(from, to))
  const slice = new Uint8Array(to - from)
  let written = 0
  let base = 0
  for (const part of parts) {
    const end = base + part.length
    if (end > from && base < to) {
      const start = Math.max(from, base) - base
      const stop = Math.min(to, end) - base
      slice.set(part.subarray(start, stop), written)
      written += stop - start
    }
    base = end
  }
  return written === 0 ? '' : utf8Decoder.decode(slice.subarray(0, written))
}

function rangeSample(parts: readonly Uint8Array[], from: number, end: number): string {
  return rangeText(parts, from, Math.min(end, from + SAMPLE_BYTES))
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
