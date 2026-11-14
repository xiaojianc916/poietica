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

/** 用时的一格：数字与单位分开，数字那一格要换等宽字（DSH 的 durationNumber）。 */
export interface RunDurationPart {
  readonly text: string
  readonly numeric: boolean
}

/*
 * 运行状态行与封条的用时（DSH formatRunDuration）：整秒向下取整，六十秒起才带分、一小时起才带小时，
 * 秒永远在场。不写「<1秒」—— 那一刻的真实长度是「不到一秒」，而屏幕上这一格量的是已经过去多久，
 * 报 0 比报一个假的界限更诚实（调用方负责把下限定到 1 秒）。
 *
 * 拆成 parts 而不是一个字符串：数字要走到等宽字那一格（tabular-nums 才排得齐），
 * 单位跟着正文走 —— 合成一个串就没法只管数字。
 *
 * 单位写死中文：界面文案与视觉都对着一份中文基准，不走 Intl 的地区差异。
 */
export function formatRunDuration(span: number): readonly RunDurationPart[] {
  /* 非有限值当 0：NaN 会一路算成「NaN秒」印到屏幕上。 */
  const total = Number.isFinite(span) ? Math.max(0, Math.floor(span / SECOND)) : 0
  const parts: RunDurationPart[] = []
  const hours = Math.floor(total / SECOND_PER_HOUR)

  if (hours > 0) {
    parts.push({ numeric: true, text: String(hours) }, { numeric: false, text: '小时' })
  }
  if (total >= SECOND_PER_MINUTE) {
    parts.push({ numeric: true, text: String(Math.floor(total / SECOND_PER_MINUTE) % SECOND_PER_MINUTE) })
    parts.push({ numeric: false, text: '分' })
  }
  parts.push({ numeric: true, text: String(total % SECOND_PER_MINUTE) }, { numeric: false, text: '秒' })

  return parts
}

/** 拼回一个字符串：给那些不需要分格的地方用（title、读屏播报）。 */
export function runDurationText(span: number): string {
  return formatRunDuration(span)
    .map((part) => part.text)
    .join('')
}
