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

const second = narrowUnit('second')
const minute = narrowUnit('minute')
const hour = narrowUnit('hour')

/** 未知或非法值不冒充零；单位交给平台本地化。 */
export function formatDuration(span: number): string | null {
  if (!Number.isFinite(span) || span < 0) {
    return null
  }
  if (span === 0) {
    return second.format(0)
  }
  if (span < SECOND) {
    return `<${second.format(1)}`
  }
  if (span < MINUTE) {
    return second.format(Math.floor(span / SECOND))
  }
  if (span < HOUR) {
    const minutes = Math.floor(span / MINUTE)
    const seconds = Math.floor((span % MINUTE) / SECOND)
    return seconds === 0
      ? minute.format(minutes)
      : `${minute.format(minutes)} ${second.format(seconds)}`
  }
  const hours = Math.floor(span / HOUR)
  const minutes = Math.floor((span % HOUR) / MINUTE)
  return minutes === 0 ? hour.format(hours) : `${hour.format(hours)} ${minute.format(minutes)}`
}
