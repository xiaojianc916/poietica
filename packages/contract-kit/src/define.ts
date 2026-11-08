import type { z } from 'zod'

export type Owner = 'core' | 'host'
/** 谁能发起这个请求。UI 指渲染进程（经 Host 转发），core / host 指另一个进程本身 */
export type Caller = 'ui' | 'core' | 'host'

export interface MethodDef<
  N extends string = string,
  P extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
> {
  readonly kind: 'method'
  readonly name: N
  readonly owner: Owner
  readonly params: P
  readonly result: R
  readonly timeoutMs: number // 默认 30_000；长任务显式声明（例如插件安装 300_000）；0 表示不超时
  readonly description: string // 一句中文说明，会出现在契约快照里
  /**
   * 只允许这些调用方（不写 = 不限，即 owner 之外的两方都能调）。Host 的 RPC Hub 按它拒绝越权请求：
   * 例如凭据库的 `secrets.*` 只给 Core，渲染进程拿不到明文（ADR-008）。
   */
  readonly callers?: readonly Caller[]
}
export interface NotificationDef<N extends string = string, P extends z.ZodType = z.ZodType> {
  readonly kind: 'notification'
  readonly name: N
  readonly owner: Owner
  readonly params: P
  readonly description: string
}

export function defineMethod<const N extends string, P extends z.ZodType, R extends z.ZodType>(d: {
  name: N
  owner: Owner
  params: P
  result: R
  timeoutMs?: number
  description: string
  callers?: readonly Caller[]
}): MethodDef<N, P, R> {
  return Object.freeze({ kind: 'method', timeoutMs: 30_000, ...d })
}
export function defineNotification<const N extends string, P extends z.ZodType>(d: {
  name: N
  owner: Owner
  params: P
  description: string
}): NotificationDef<N, P> {
  return Object.freeze({ kind: 'notification', ...d })
}

/** 定义一个功能的错误码。返回 { key: '<ns>.<key>' }，值即 AppError.code。messages 为默认中文提示（UI 兜底展示）。 */
export function defineErrors<const NS extends string, const T extends Record<string, string>>(
  namespace: NS,
  messages: T,
): { readonly [K in keyof T & string]: `${NS}.${K}` } & { readonly __messages: Readonly<Record<string, string>> } {
  const codes: Record<string, string> = {}
  const all: Record<string, string> = {}
  for (const [k, msg] of Object.entries(messages)) {
    codes[k] = `${namespace}.${k}`
    all[`${namespace}.${k}`] = msg
  }
  return Object.freeze({ ...codes, __messages: Object.freeze(all) }) as never
}

export interface Contract<
  M extends readonly MethodDef[] = readonly MethodDef[],
  N extends readonly NotificationDef[] = readonly NotificationDef[],
> {
  readonly id: string // 等于功能 id
  readonly namespaces: readonly string[] // 方法/通知名的第一段必须属于这里
  readonly methods: M
  readonly notifications: N
  readonly errors: { readonly __messages: Readonly<Record<string, string>> }
}
export function defineContract<const C extends Contract>(c: C): C {
  return Object.freeze(c)
}
