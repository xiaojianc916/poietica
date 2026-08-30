/**
 * 窄化 unknown 到普通对象：null 与数组都不算。
 *
 * 收失败的载荷时最常用：报错方塞过来的一切先过这一关，再谈取字段。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
