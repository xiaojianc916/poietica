/*
 * 一次失败，说成一句话 —— 原样，不改写。
 *
 * 会话层此前有三份逐字相同的错：判据是 cause instanceof Error，不是就换成一句
 * 写死的短句。而 Tauri 的 invoke 在命令返回 Err 时抛的是序列化后的负载，多数
 * 情况下是对象或字符串 —— 也就是说真正说明了出什么事的那一份，恰好走被换掉的
 * 那条分支。Error.cause 那条链也从头到尾没有人读过，而末端那一环往往才是原因。
 *
 * 报错是给人排查用的。替人决定他不需要知道，是这三处共同的错。
 */
export function describeFailure(cause: unknown): string {
  if (cause instanceof Error) {
    const head = cause.message.length > 0 ? `${cause.name}: ${cause.message}` : cause.name

    return cause.cause === undefined ? head : `${head}\n← ${describeFailure(cause.cause)}`
  }

  if (typeof cause === 'string') {
    return cause
  }

  try {
    return JSON.stringify(cause) ?? String(cause)
  } catch {
    return String(cause)
  }
}
