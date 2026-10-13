/**
 * 程序不变量被破坏，**不是业务错误**。它不进任何契约的错误码表；跨 RPC 边界时由内核统一折成
 * `kernel.internal`，原始 message 与 stack 保留在日志里。
 */
export class InvariantError extends Error {
  override readonly name = 'InvariantError'
}

/** 断言程序不变量。会跨边界或被用户看到的用 `AppError` + 本功能错误码；只可能是「代码写错」的用这里。 */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantError(message)
}

/** 穷尽检查：switch 的 default 分支调用它，漏掉某个分支时编译报错。 */
export function assertNever(value: never, message = '不应到达的分支'): never {
  throw new InvariantError(`${message}：${String(value as unknown)}`)
}
