import type { IpcError } from './generated/ipc-bindings'

/**
 * 原生错误契约的唯一来源是 Rust 的 error.rs，跨 IPC 之后 code 是字面量联合，
 * 所以拼错的 code 编译期就会被拦住。
 */
export type { IpcError }

function isIpcError(value: unknown): value is IpcError {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate['code'] === 'string' &&
    typeof candidate['message'] === 'string' &&
    typeof candidate['recoverable'] === 'boolean'
  )
}

class IpcInvocationError extends Error {
  readonly details: IpcError

  constructor(details: IpcError) {
    super(details.message)
    this.name = 'IpcInvocationError'
    this.details = details
  }
}

/**
 * 一次原生调用，只有这一条路。
 *
 * 原生侧抛出来的是一个 IpcError 形状的裸对象，不是 Error 实例：它没有栈，
 * instanceof 认不出来，catch 到之后只能靠鸭子类型再判一遍。包成 IpcInvocationError
 * 是为了让上层只需要认一个类型。
 *
 * 这条规则此前写在三处 —— invoke.ts、agent.ts 里的私有 call()、以及
 * desktop-adapters 的 native-crash-report.ts 各自的 try/catch。同一条规则写三遍，
 * 就会有一天只改了一遍。
 */
export async function throughIpc<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (isIpcError(error)) {
      throw new IpcInvocationError(error)
    }

    throw error
  }
}
