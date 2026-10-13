/* 用量页的算术：一本按天的账铺成日历，或一串时刻点成概览。不认识 React 也不认识 store。索引用本地日历字段，显示用 Intl。
 * 跨天加减走 Date 构造器的溢出归一：夏令时那天只有 23 小时，86_400_000 乘法会错一格。 */
/** 一天，以及那天的量。量是什么由调用方决定 —— 热力图喂的是 token。 */
export interface ActivityDay {
  readonly date: string
  readonly count: number
}

export interface UsageLedgerDay {
  readonly day: string
  readonly tokens: number
}

export interface UsageModelDay {
  readonly day: string
  readonly model: string
  readonly tokens: number
}

export type ReadTokenDays = (span: number) => Promise<readonly UsageLedgerDay[]>
export type ReadModelDays = (span: number) => Promise<readonly UsageModelDay[]>
export type ReadMessageCount = (span: number) => Promise<number>

export interface ThreadActivity {
  readonly threads: number
  readonly activeDays: number
  readonly streak: number
}

export const HEAT_LEVELS = [0, 1, 2, 3, 4] as const

export function dayKeyOf(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')

  return `${at.getFullYear()}-${month}-${day}`
}

/* 键读回时刻必须补 T00:00:00：纯日期字符串按 UTC 解析，UTC 以西的时区会读成前一天。 */
export function dateOf(key: string): Date {
  return new Date(`${key}T00:00:00`)
}

export function shiftDays(from: Date, delta: number): Date {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + delta)
}

export function weekdayOf(key: string): number {
  return dateOf(key).getDay()
}

export function spread(amounts: ReadonlyMap<string, number>, now: Date, span: number): readonly ActivityDay[] {
  const days: ActivityDay[] = []

  for (let index = span - 1; index >= 0; index -= 1) {
    const date = dayKeyOf(shiftDays(now, -index))

    days.push({ date, count: amounts.get(date) ?? 0 })
  }

  return days
}

export interface ModelSeries {
  readonly model: string
  readonly label: string
  readonly days: readonly ActivityDay[]
}

export function modelSeries(rows: readonly UsageModelDay[], now: Date, span: number): readonly ModelSeries[] {
  const byModel = new Map<string, Map<string, number>>()

  for (const row of rows) {
    const ledger = byModel.get(row.model) ?? new Map<string, number>()
    ledger.set(row.day, (ledger.get(row.day) ?? 0) + row.tokens)
    byModel.set(row.model, ledger)
  }

  return [...byModel]
    .map(([model, ledger]) => ({
      model,
      label: model,
      days: spread(ledger, now, span),
      total: [...ledger.values()].reduce((sum, tokens) => sum + tokens, 0),
    }))
    .sort((left, right) => right.total - left.total)
    .map(({ model, label, days }) => ({ model, label, days }))
}

export function spreadWeeks(amounts: ReadonlyMap<string, number>, now: Date, weeks: number): readonly ActivityDay[] {
  const end = shiftDays(now, 6 - weekdayOf(dayKeyOf(now)))
  const days: ActivityDay[] = []

  for (let index = weeks * 7 - 1; index >= 0; index -= 1) {
    const date = dayKeyOf(shiftDays(end, -index))

    days.push({ date, count: amounts.get(date) ?? 0 })
  }

  return days
}

export function busiestOf(days: readonly ActivityDay[]): number {
  return days.reduce((most, day) => Math.max(most, day.count), 0)
}

export function levelOf(count: number, busiest: number): number {
  if (count <= 0 || busiest <= 0) {
    return 0
  }

  return Math.max(1, Math.ceil((count / busiest) * 4))
}

const THOUSAND = 1_000
const MILLION = 1_000_000

const PLAIN = new Intl.NumberFormat('zh-CN')

export function formatTokens(count: number): string {
  if (count < THOUSAND) {
    return PLAIN.format(count)
  }

  const thousands = count / THOUSAND

  if (thousands < 999.95) {
    return `${thousands.toFixed(1)}K`
  }

  return `${(count / MILLION).toFixed(2)}M`
}

function countBy(times: readonly string[]): ReadonlyMap<string, number> {
  const counted = new Map<string, number>()

  for (const time of times) {
    const key = dayKeyOf(new Date(time))

    counted.set(key, (counted.get(key) ?? 0) + 1)
  }

  return counted
}

/* 今天还没活动时从昨天算起：计数器的通行读法是「到目前为止连续了几天」，早上八点把昨天以前的成绩清掉说的不是同一件事。不受窗口约束。 */
function streakOf(counted: ReadonlyMap<string, number>, today: Date): number {
  const offset = counted.has(dayKeyOf(today)) ? 0 : 1
  let length = 0

  while (counted.has(dayKeyOf(shiftDays(today, -(offset + length))))) {
    length += 1
  }

  return length
}

export function summarize(times: readonly string[], now: Date, span: number): ThreadActivity {
  const counted = countBy(times)
  let threads = 0
  let activeDays = 0

  for (const day of spread(counted, now, span)) {
    threads += day.count
    activeDays += day.count > 0 ? 1 : 0
  }

  return { threads, activeDays, streak: streakOf(counted, now) }
}
