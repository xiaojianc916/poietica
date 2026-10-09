const REDACTED = '[redacted]'
const MAX_STRING = 8 * 1024
const MAX_DEPTH = 6

/**
 * 键名（转小写并去掉 _ 和 -）以这些词结尾、或恰好等于 key 时，若值是字符串就替换为 [redacted]。
 * 只脱敏字符串：inputTokens 这类数值字段不是凭据，保持原样。
 */
const SECRET_KEY =
  /(apikey|accesskey|secretkey|privatekey|token|secret|password|passwd|authorization|cookie|credential)s?$/

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[_-]/g, '')
  return k === 'key' || SECRET_KEY.test(k)
}

function truncate(s: string): string {
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…[truncated ${s.length - MAX_STRING}]` : s
}

/**
 * 返回脱敏后的深拷贝（输入不被修改）。同时：Error 转成 {name, message, stack}；超长字符串截断；
 * 超过 6 层的对象替换为 '[depth]'；循环引用替换为 '[circular]'；bigint 转字符串；函数与 symbol 丢弃。
 */
export function redactSecrets(value: unknown): unknown {
  const seen = new WeakSet<object>()
  const walk = (v: unknown, depth: number, key: string | null): unknown => {
    if (typeof v === 'string') return key !== null && isSecretKey(key) ? REDACTED : truncate(v)
    if (typeof v === 'bigint') return v.toString()
    if (typeof v === 'function' || typeof v === 'symbol') return undefined
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v)) return '[circular]'
    if (depth >= MAX_DEPTH) return '[depth]'
    seen.add(v)
    if (v instanceof Error) {
      return {
        name: v.name,
        message: truncate(v.message),
        ...(v.stack === undefined ? {} : { stack: truncate(v.stack) }),
      }
    }
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1, null))
    const out: Record<string, unknown> = {}
    for (const [k, item] of Object.entries(v)) {
      const next = walk(item, depth + 1, k)
      if (next !== undefined) out[k] = next
    }
    return out
  }
  return walk(value, 0, null)
}
