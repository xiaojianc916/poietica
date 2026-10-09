import type { RpcMessage } from './messages'

export const FRAME_PREFIX = '\x1e'

export function encodeFrame(message: RpcMessage): string {
  return `${FRAME_PREFIX}${JSON.stringify(message)}\n`
}
export function encodeLine(message: RpcMessage): string {
  return `${JSON.stringify(message)}\n`
}

/** 增量解码器。requirePrefix=true 用于 Core stdout；false 用于 Core stdin（纯行 JSON）。 */
export class FrameDecoder {
  private buffer = ''
  constructor(
    private readonly requirePrefix: boolean,
    private readonly onMessage: (message: RpcMessage) => void,
    private readonly onStray: (text: string) => void,
  ) {}

  push(chunk: string): void {
    this.buffer += chunk
    let nl = this.buffer.indexOf('\n')
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '')
      this.buffer = this.buffer.slice(nl + 1)
      this.handleLine(line)
      nl = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > 64 * 1024 * 1024) {
      this.onStray(`[frame overflow] ${this.buffer.slice(0, 200)}`)
      this.buffer = ''
    }
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
