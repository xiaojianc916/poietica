import type { SerializedAppError } from '@poietica/foundation'

export type RpcId = number
export interface RequestMessage {
  readonly jsonrpc: '2.0'
  readonly id: RpcId
  readonly method: string
  readonly params: unknown
  readonly meta?: RpcMeta
}
export interface NotificationMessage {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params: unknown
}
export interface SuccessMessage {
  readonly jsonrpc: '2.0'
  readonly id: RpcId
  readonly result: unknown
}
export interface ErrorObject {
  readonly code: number
  readonly message: string
  readonly data: SerializedAppError
}
export interface ErrorMessage {
  readonly jsonrpc: '2.0'
  readonly id: RpcId | null
  readonly error: ErrorObject
}
export type RpcMessage = RequestMessage | NotificationMessage | SuccessMessage | ErrorMessage

/** 扩展字段：跨进程追踪。traceId 由最初发起方（通常是 UI）生成，Host 转发给 Core 时原样携带。 */
export interface RpcMeta {
  readonly traceId: string
  readonly origin: 'ui' | 'host' | 'core'
}

export const CANCEL_METHOD = '$/cancelRequest' // params: { id: RpcId }

export function isRequest(m: RpcMessage): m is RequestMessage {
  return 'method' in m && 'id' in m
}
export function isNotification(m: RpcMessage): m is NotificationMessage {
  return 'method' in m && !('id' in m)
}
export function isResponse(m: RpcMessage): m is SuccessMessage | ErrorMessage {
  return !('method' in m)
}
