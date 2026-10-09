/** 逐字迁移自 legacy `surface/timeline/timeline-contract.ts` 的 formatByteSize。 */
export function formatByteSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return undefined
  }
  if (bytes < 1024) {
    return `${String(bytes)}B`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  const shown =
    value >= 100 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(2).replace(/\.?0+$/, '')
  // 四舍五入能把 1023.99 推成 1024：那是下一个单位。
  if (Number(shown) >= 1024 && unit < units.length - 1) {
    return `1${units[unit + 1]}`
  }
  return `${shown}${units[unit]}`
}
