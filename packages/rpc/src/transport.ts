import type { Disposable } from '@poietica/foundation'
import type { RpcMessage } from './messages'

export interface Transport {
  send(message: RpcMessage): void
  onMessage(listener: (message: RpcMessage) => void): Disposable
  onClose(listener: (reason: string) => void): Disposable
  close(reason: string): void
}
