import { type Disposable, Emitter } from '@poietica/foundation'
import type { RpcMessage } from './messages'

/** 三种传输共用：管理 onMessage/onClose 监听器与“只关闭一次”的状态 */
export class TransportCore implements Disposable {
  private readonly messages = new Emitter<RpcMessage>()
  private readonly closes = new Emitter<string>()
  private closedReason: string | null = null

  get closed(): boolean {
    return this.closedReason !== null
  }

  onMessage(listener: (message: RpcMessage) => void): Disposable {
    return this.messages.event(listener)
  }

  onClose(listener: (reason: string) => void): Disposable {
    return this.closes.event(listener)
  }

  deliver(message: RpcMessage): void {
    if (this.closedReason === null) this.messages.fire(message)
  }

  /** 返回 true 表示这是第一次关闭（调用方据此释放底层资源） */
  markClosed(reason: string): boolean {
    if (this.closedReason !== null) return false
    this.closedReason = reason
    this.closes.fire(reason)
    return true
  }

  dispose(): void {
    this.messages.dispose()
    this.closes.dispose()
  }
}

export function isRpcMessage(value: unknown): value is RpcMessage {
  return typeof value === 'object' && value !== null && (value as { jsonrpc?: unknown }).jsonrpc === '2.0'
}
