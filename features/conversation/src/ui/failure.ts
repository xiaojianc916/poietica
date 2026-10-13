/* 原样，不改写：宿主端口抛的是序列化后的负载（对象或字符串），按 `cause instanceof Error` 判定只会把真正说明问题的那一份换成写死的短句。 */
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
