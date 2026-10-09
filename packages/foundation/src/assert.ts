/**
 * 程序不变量被破坏。**不是业务错误**：它表示「代码写对了就不该发生」的情况
 * （数组越界、缺 Provider / Context、switch 走到不该到的分支）。
 *
 * 它不进任何契约的错误码表；跨 RPC 边界时由内核统一折成 `kernel.internal`
 * （`toAppError` 的兜底分支就是这条），原始 message 与 stack 保留在日志里。
 */
export class InvariantError extends Error {
  override readonly name = 'InvariantError'
}

/**
 * 断言程序不变量。条件不成立时抛 `InvariantError`。
 *
 * 与 `AppError` 的分工（02 页「错误即数据」+ 09 页 §4 第 5 条的三类判定）：
 * 会跨边界或被用户看到的 → `AppError` + 本功能的错误码；
 * 只可能是「代码写错」的 → 这里。
 */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantError(message)
}

/** 穷尽检查：switch 的 default 分支调用它，漏掉某个分支时编译报错 */
export function assertNever(value: never, message = '不应到达的分支'): never {
  throw new InvariantError(`${message}：${String(value as unknown)}`)
}
