import { LineSplitter } from '@poietica/foundation'
import type { RpcMessage } from './messages'

export const FRAME_PREFIX = '\x1e'

export function encodeFrame(message: RpcMessage): string {
  return `${FRAME_PREFIX}${JSON.stringify(message)}\n`
}
export function encodeLine(message: RpcMessage): string {
  return `${JSON.stringify(message)}\n`
}

/** 单帧上限（字符数）。超过即视为对端失控：报一次 `[frame overflow]` 并丢弃到下一个换行 */
export const MAX_FRAME_CHARS = 64 * 1024 * 1024

/**
 * 增量解码器。requirePrefix=true 用于 Core stdout；false 用于 Core stdin（纯行 JSON）。
 * 切行交给 foundation 的 LineSplitter（线性时间、只认 `\n`），这里只管「一行 → 一条消息」。
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
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      this.onStray(`[bad frame] ${body.slice(0, 200)}`)
      return
    }
    if (typeof parsed !== 'object' || parsed === null || (parsed as { jsonrpc?: unknown }).jsonrpc !== '2.0') {
      this.onStray(`[not jsonrpc] ${body.slice(0, 200)}`)
      return
    }
    this.onMessage(parsed as RpcMessage)
  }
}
