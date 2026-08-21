import { v7 as uuidv7 } from 'uuid'

export type Brand<T, B> = T & { readonly __brand: B }

export type AssetId = Brand<string, 'AssetId'>
export type CommandId = Brand<string, 'CommandId'>
export type TransactionId = Brand<string, 'TransactionId'>
export type ActorId = Brand<string, 'ActorId'>
export type RequestId = Brand<string, 'RequestId'>
export type SessionId = Brand<string, 'SessionId'>
export type WindowId = Brand<string, 'WindowId'>
export type AutomationId = Brand<string, 'AutomationId'>

export type AnyId =
  | AssetId
  | CommandId
  | TransactionId
  | ActorId
  | RequestId
  | SessionId
  | WindowId
  | AutomationId

/** 所有 id 只有品牌不同：类型上靠品牌区分，运行时一份实现。 */
const newId =
  <T extends string>(): (() => T) =>
  () =>
    uuidv7() as T

export const createAssetId = newId<AssetId>()
export const createCommandId = newId<CommandId>()
export const createTransactionId = newId<TransactionId>()
export const createActorId = newId<ActorId>()
export const createRequestId = newId<RequestId>()
export const createSessionId = newId<SessionId>()
export const createWindowId = newId<WindowId>()
export const createAutomationId = newId<AutomationId>()
