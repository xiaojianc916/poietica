import type { AppError } from './errors'

/** 用于“失败是正常结果之一”的纯函数（例如解析）。跨进程的失败一律用 AppError 抛出，不用 Result */
export type Result<T, E = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}
