/** 上游插件的返回值是动态 JSON；这个包里只保留一个对象守卫。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
