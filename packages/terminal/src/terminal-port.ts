/*
 * 宿主契约：终端这一格需要原生侧提供哪些动作。
 *
 * 词汇说字节，不说 base64 —— 传输编码归适配层。屏幕上那条经过的唯一真相在
 * 原生侧的会话表：回放与实时走同一个通道、同一种信号，所以这里只有一种形状。
 */

/** 通道上的一件事。 */
export type TerminalSignal =
  | { readonly kind: 'output'; readonly bytes: Uint8Array }
  | { readonly kind: 'exited' }

export interface TerminalHostPort {
  /** 先订阅再接上：回放是这个通道上的第一批字节，因此不重不漏。 */
  readonly watch: (root: string, onSignal: (signal: TerminalSignal) => void) => Promise<() => void>
  readonly attach: (root: string, cols: number, rows: number) => Promise<void>
  readonly write: (root: string, bytes: Uint8Array) => Promise<void>
  readonly resize: (root: string, cols: number, rows: number) => Promise<void>
  readonly close: (root: string) => Promise<void>
}
