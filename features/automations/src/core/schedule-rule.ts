import type { ScheduleRule } from '../contract/entities'

/*
 * 自定义重复规则的下一次运行。ZCode 的同一套算法只按本机时区算日历；Poietica 的任务带 IANA 时区，
 * 所以这里把所有日历运算都换到「任务时区的墙上时间」：先把 epoch 拆成墙钟年月日时分，加减天数/月数，
 * 再用两轮偏移回推 epoch（覆盖 DST 跳变）。分钟/小时是固定时长，直接按毫秒推进。
 */

interface WallTime {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
}

const FIELDS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
}

/** 最长搜索边界：100 年（月）/ 100 年（周）/ 100 年（日）之外的规则视为没有下一次。 */
const SEARCH_DAYS = 36_600
const SEARCH_WEEKS = 5_220
const SEARCH_MONTHS = 1_200
const SEARCH_YEARS = 400

function wallOf(at: number, timeZone: string): WallTime {
  const parts = new Intl.DateTimeFormat('en-US', { ...FIELDS, timeZone }).formatToParts(at)
  const num = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: num('year'), month: num('month'), day: num('day'), hour: num('hour'), minute: num('minute') }
}

/** 该时刻在目标时区的偏移（毫秒）；epoch 都是整分钟，秒位不参与。 */
function offsetOf(epoch: number, timeZone: string): number {
  const wall = wallOf(epoch, timeZone)
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - epoch
}

/** 把任务时区的墙上时间合回 epoch；两轮偏移足以跨过 DST。 */
function epochOfWall(wall: WallTime, timeZone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  const first = asUtc - offsetOf(asUtc, timeZone)
  const second = asUtc - offsetOf(first, timeZone)
  return second === first ? first : second
}

const utcDate = (year: number, month: number, day: number): Date => new Date(Date.UTC(year, month - 1, day))

function addDays(wall: WallTime, days: number): WallTime {
  const date = utcDate(wall.year, wall.month, wall.day + days)
  return { ...wall, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function monthFirst(year: number, month: number, offset: number): { year: number; month: number } {
  const date = new Date(Date.UTC(year, month - 1 + offset, 1))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** ISO 星期：1=周一 … 7=周日。 */
function isoWeekday(wall: WallTime): number {
  const dow = utcDate(wall.year, wall.month, wall.day).getUTCDay()
  return dow === 0 ? 7 : dow
}

function mondayOf(wall: WallTime): WallTime {
  return addDays(wall, -(isoWeekday(wall) - 1))
}

function firstWeekdayOfMonth(year: number, month: number, weekday: number): number {
  const first = utcDate(year, month, 1)
  const firstIso = first.getUTCDay() === 0 ? 7 : first.getUTCDay()
  return 1 + ((weekday - firstIso + 7) % 7)
}

function atTime(wall: WallTime, hour: number, minute: number): WallTime {
  return { ...wall, hour, minute }
}

function nextMinute(rule: ScheduleRule, from: number): number {
  const step = rule.interval * 60_000
  /* 从固定 anchor 推进，避免调度晚点逐轮累积漂移；第一次在 anchor 之后一个间隔。 */
  const steps = Math.max(1, Math.floor((from - rule.anchorAt) / step) + 1)
  return rule.anchorAt + steps * step
}

function nextHourly(rule: ScheduleRule, anchor: WallTime, timeZone: string, from: number): number {
  const base = epochOfWall(atTime(anchor, anchor.hour, rule.minute), timeZone)
  const step = rule.interval * 3_600_000
  const steps = Math.max(0, Math.floor((from - base) / step) + 1)
  return base + steps * step
}

function nextDaily(rule: ScheduleRule, anchor: WallTime, timeZone: string, from: number): number | null {
  for (let index = 0; index < SEARCH_DAYS; index += 1) {
    const date = addDays(anchor, index * rule.interval)
    const candidate = epochOfWall(atTime(date, rule.hour, rule.minute), timeZone)
    if (candidate > from) return candidate
  }
  return null
}

function nextWeekly(rule: ScheduleRule, anchor: WallTime, timeZone: string, from: number): number | null {
  const start = mondayOf(anchor)
  const weekdays = [...(rule.weekdays?.length ? rule.weekdays : [1])].sort((left, right) => left - right)
  for (let week = 0; week < SEARCH_WEEKS; week += rule.interval) {
    const candidate = weekdays
      .map((weekday) => addDays(start, week * 7 + (weekday - 1)))
      .map((date) => epochOfWall(atTime(date, rule.hour, rule.minute), timeZone))
      .find((at) => at > from)
    if (candidate !== undefined) return candidate
  }
  return null
}

function monthDaysOf(rule: ScheduleRule, year: number, month: number): number[] {
  if (rule.monthlyMode === 'weekday') return [firstWeekdayOfMonth(year, month, rule.weekdays?.[0] ?? 1)]
  return (rule.monthDays?.length ? [...rule.monthDays].sort((left, right) => left - right) : [1]).filter(
    (day) => day <= daysInMonth(year, month),
  )
}

function nextMonthly(rule: ScheduleRule, anchor: WallTime, timeZone: string, from: number): number | null {
  for (let offset = 0; offset <= SEARCH_MONTHS; offset += rule.interval) {
    const { year, month } = monthFirst(anchor.year, anchor.month, offset)
    const candidate = monthDaysOf(rule, year, month)
      .map((day) => epochOfWall(atTime({ ...anchor, year, month, day }, rule.hour, rule.minute), timeZone))
      .find((at) => at > from)
    if (candidate !== undefined) return candidate
  }
  return null
}

function nextYearly(rule: ScheduleRule, anchor: WallTime, timeZone: string, from: number): number | null {
  /* 月份取 months[0] 或锚点月，日期取 monthDays[0] 或锚点日；2/30、非闰年 2/29 这类溢出整年跳过。 */
  const targetMonth = rule.months?.[0] ?? anchor.month
  const targetDay = rule.monthDays?.[0] ?? anchor.day
  for (let offset = 0; offset < SEARCH_YEARS; offset += rule.interval) {
    const year = anchor.year + offset
    if (targetDay > daysInMonth(year, targetMonth)) continue
    const candidate = epochOfWall(
      atTime({ ...anchor, year, month: targetMonth, day: targetDay }, rule.hour, rule.minute),
      timeZone,
    )
    if (candidate > from) return candidate
  }
  return null
}

/** 规则的下一次运行；null 表示搜索边界内没有下一次。 */
export function computeRuleNext(rule: ScheduleRule, timeZone: string, from: number): number | null {
  const normalized = { ...rule, interval: Math.max(1, Math.floor(rule.interval)) }
  const anchor = wallOf(rule.anchorAt, timeZone)
  switch (normalized.unit) {
    case 'minute':
      return nextMinute(normalized, from)
    case 'hourly':
      return nextHourly(normalized, anchor, timeZone, from)
    case 'daily':
      return nextDaily(normalized, anchor, timeZone, from)
    case 'weekly':
      return nextWeekly(normalized, anchor, timeZone, from)
    case 'monthly':
      return nextMonthly(normalized, anchor, timeZone, from)
    case 'yearly':
      return nextYearly(normalized, anchor, timeZone, from)
  }
}

/**
 * 把受控 carrier（unit + interval + 兼容 cron 解出的字段）归一化成权威规则。
 * 与 ZCode 的 buildIntervalScheduleRule 同语义，只是锚点固定为调用方传入的创建/修改时刻。
 */
export function ruleFromInterval(
  unit: ScheduleRule['unit'],
  interval: number,
  fields: {
    readonly hour: number
    readonly minute: number
    readonly weekdays?: readonly number[] | undefined
    readonly monthDays?: readonly number[] | undefined
    readonly months?: readonly number[] | undefined
  },
  anchorAt: number,
): ScheduleRule {
  return {
    unit,
    interval,
    hour: fields.hour,
    minute: fields.minute,
    anchorAt,
    ...(fields.weekdays === undefined ? {} : { weekdays: [...fields.weekdays] }),
    ...(fields.monthDays === undefined ? {} : { monthDays: [...fields.monthDays] }),
    ...(fields.months === undefined ? {} : { months: [...fields.months] }),
    ...(unit === 'monthly' ? { monthlyMode: 'date' as const } : {}),
  }
}

export interface CompatFields {
  readonly hour: number
  readonly minute: number
  readonly weekdays?: readonly number[] | undefined
  readonly monthDays?: readonly number[] | undefined
  readonly months?: readonly number[] | undefined
}

/** carrier 没带兼容 cron 时用锚点的墙钟做默认值：时分、当月当日、当天星期、锚点月份。 */
export function defaultFields(anchorAt: number, timeZone: string): CompatFields {
  const wall = wallOf(anchorAt, timeZone)
  return {
    hour: wall.hour,
    minute: wall.minute,
    weekdays: [isoWeekday(wall)],
    monthDays: [wall.day],
    months: [wall.month],
  }
}

/** 单值或闭区间；越界/非整数返回 undefined，由调用方整体回退。 */
function pieceValues(piece: string, min: number, max: number): number[] | undefined {
  const range = /^(\d+)-(\d+)$/.exec(piece)
  if (range !== null) {
    const from = Number(range[1])
    const to = Number(range[2])
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to || from < min || to > max) return undefined
    return Array.from({ length: to - from + 1 }, (_, index) => from + index)
  }
  const value = Number(piece)
  return Number.isInteger(value) && value >= min && value <= max ? [value] : undefined
}

function numericList(token: string | undefined, min: number, max: number): number[] | undefined {
  if (token === undefined || token === '*' || token === '?') return undefined
  const values: number[] = []
  for (const piece of token.split(',')) {
    const parsed = pieceValues(piece, min, max)
    if (parsed === undefined) return undefined
    values.push(...parsed)
  }
  return values.length > 0 ? values : undefined
}

function single(token: string | undefined, fallback: number, max: number): number {
  if (token === undefined) return fallback
  const value = Number(token)
  return Number.isInteger(value) && value >= 0 && value <= max ? value : fallback
}

/** 星期统一成 ISO：cron 的 0 与 7 都是周日。 */
function weekdaysOf(token: string | undefined): number[] | undefined {
  return numericList(token, 0, 7)?.map((day) => (day === 0 ? 7 : day))
}

/**
 * 兼容 cron 的字段解析：只认单值和列表/范围；步长、`#` 这类表达超出 carrier 场景，回退锚点。
 */
export function parseCompatFields(cronExpr: string, anchorAt: number, timeZone: string): CompatFields {
  const fallback = defaultFields(anchorAt, timeZone)
  const [minuteToken, hourToken, domToken, monthToken, dowToken] = cronExpr.trim().split(/\s+/)
  if (minuteToken === undefined) return fallback
  return {
    minute: single(minuteToken, fallback.minute, 59),
    hour: single(hourToken, fallback.hour, 23),
    weekdays: weekdaysOf(dowToken),
    monthDays: numericList(domToken, 1, 31),
    months: numericList(monthToken, 1, 12),
  }
}

const COMPAT_CRON: Readonly<Record<ScheduleRule['unit'], (rule: ScheduleRule) => string>> = {
  minute: (rule) => (rule.interval <= 59 ? `*/${rule.interval} * * * *` : '0 * * * *'),
  hourly: (rule) => (rule.interval <= 23 ? `0 */${rule.interval} * * *` : '0 0 * * *'),
  daily: (rule) =>
    rule.interval <= 31 ? `${rule.minute} ${rule.hour} */${rule.interval} * *` : `${rule.minute} ${rule.hour} * * *`,
  weekly: (rule) =>
    `${rule.minute} ${rule.hour} * * ${(rule.weekdays?.length ? rule.weekdays : [1])
      .map((day) => (day === 7 ? 0 : day))
      .join(',')}`,
  monthly: (rule) => `${rule.minute} ${rule.hour} ${(rule.monthDays?.length ? rule.monthDays : [1]).join(',')} * *`,
  yearly: (rule) => `${rule.minute} ${rule.hour} ${rule.monthDays?.[0] ?? 1} ${rule.months?.[0] ?? 1} *`,
}

/** 由规则反推一条合法的兼容 cron 给编辑器与卡片展示；真实节奏仍由规则决定。 */
export function compatCronOf(rule: ScheduleRule): string {
  return COMPAT_CRON[rule.unit](rule)
}
