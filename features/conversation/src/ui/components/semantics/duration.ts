export const SECOND = 1_000
export const MINUTE = 60_000
export const HOUR = 3_600_000
export const DAY = 86_400_000

export function narrowUnit(unit: string): Intl.NumberFormat {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
    style: 'unit',
    unit,
    unitDisplay: 'narrow',
  })
}

const SECOND_PER_MINUTE = 60
const SECOND_PER_HOUR = 3600

/*
 * 运行状态行与封条的用时（DSH formatRunDuration）：整秒向下取整，六十秒起才带分、一小时起才带小时，
 * 秒永远在场。不写「<1秒」—— 那一刻的真实长度是「不到一秒」，而屏幕上这一格量的是已经过去多久，
 * 报 0 比报一个假的界限更诚实（调用方负责把下限定到 1 秒）。
 *
 * 单位写死中文：界面文案与视觉都对着一份中文基准，不走 Intl 的地区差异。
 */
export function formatRunDuration(span: number): string {
  /* 非有限值当 0：NaN 会一路算成「NaN秒」印到屏幕上。 */
  const total = Number.isFinite(span) ? Math.max(0, Math.floor(span / SECOND)) : 0
  const parts: string[] = []
  const hours = Math.floor(total / SECOND_PER_HOUR)

  if (hours > 0) {
    parts.push(`${String(hours)}小时`)
  }
  if (total >= SECOND_PER_MINUTE) {
    parts.push(`${String(Math.floor(total / SECOND_PER_MINUTE) % SECOND_PER_MINUTE)}分`)
  }
  parts.push(`${String(total % SECOND_PER_MINUTE)}秒`)

  return parts.join('')
}
