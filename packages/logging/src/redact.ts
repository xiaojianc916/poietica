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

/** walk 的哨兵：叶子那一格已经就地算完，不用再往下走 */
const MISS = Symbol('miss')

function leafOf(value: unknown, key: string | null): unknown {
  if (typeof value === 'string') return key !== null && isSecretKey(key) ? REDACTED : truncate(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  return MISS
}

function errorOf(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: truncate(error.message),
    ...(error.stack === undefined ? {} : { stack: truncate(error.stack) }),
  }
}

/** 一层普通对象：丢掉脱敏后变成 undefined 的格（函数与 symbol 就是这种） */
function objectOf(source: object, walk: (item: unknown, key: string) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, item] of Object.entries(source)) {
    const next = walk(item, k)
    if (next !== undefined) out[k] = next
  }
  return out
}

/**
 * 返回脱敏后的深拷贝（输入不被修改）。同时：Error 转成 {name, message, stack}；超长字符串截断；
 * 超过 6 层的对象替换为 '[depth]'；循环引用替换为 '[circular]'；bigint 转字符串；函数与 symbol 丢弃。
 */
export function redactSecrets(value: unknown): unknown {
  const seen = new WeakSet<object>()
  const walk = (v: unknown, depth: number, key: string | null): unknown => {
    const leaf = leafOf(v, key)
    if (leaf !== MISS) return leaf
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v)) return '[circular]'
    if (depth >= MAX_DEPTH) return '[depth]'
    seen.add(v)
    if (v instanceof Error) return errorOf(v)
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1, null))
    return objectOf(v, (item, k) => walk(item, depth + 1, k))
  }
  return walk(value, 0, null)
}
