/*
 * 用量页的算术：一本按天的账铺成一段日历，或者一串时刻点成一份概览。
 *
 * 这一段不认识 React，也不认识 ThreadsStore：进来的是数据，出去的是数。
 *
 * 日历分两半：对内索引用本地日历字段，对外显示用 Intl。索引不能借某个 locale
 * 的短日期格式当键 —— 那是排版，不是标识；显示也不能自己拼，那是手搓国际化。
 *
 * 跨天加减一律走 Date 构造器的溢出归一，不用 86_400_000 乘法：夏令时那天只有
 * 23 小时，乘法会把整张图错开一格。
 */

/** 一天，以及那天的量。量是什么由调用方决定 —— 热力图喂的是 token。 */
export interface ActivityDay {
  readonly date: string
  readonly count: number
}

/** 概览的三项。它们全部出自对话列表本身，与 token 无关。 */
export interface ThreadActivity {
  readonly threads: number
  readonly activeDays: number
  readonly streak: number
}

/** 五档，与 GitHub 贡献图同档数。 */
export const HEAT_LEVELS = [0, 1, 2, 3, 4] as const

/** 这一天的键。只作索引用，不出现在屏幕上。 */
export function dayKeyOf(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')

  return `${at.getFullYear()}-${month}-${day}`
}

/*
 * 把键读回一个时刻。
 *
 * 补上 T00:00:00 不是装饰：只写日期的字符串按 UTC 解析，带时刻的按本地解析，
 * 这是 ECMA-262 的 Date Time String Format 明文规定的两条路。少了它，东八区的
 * 每一天都会落到前一天，整张热力图整体错一格。
 */
export function dateOf(key: string): Date {
  return new Date(`${key}T00:00:00`)
}

/** 从这一天起算的第 delta 天。溢出由 Date 自己归一。 */
export function shiftDays(from: Date, delta: number): Date {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + delta)
}

/** 这一天是周几，周一记 0：中文界面的一周从周一起算，而 getDay 把周日记作 0。 */
export function weekdayOf(key: string): number {
  return (dateOf(key).getDay() + 6) % 7
}

/**
 * 把一本按天的账铺到最近 span 天上，缺的日子补 0，由早到晚。
 *
 * 账是空的也照铺 —— 热力图要的是一段完整的日历，不是有数据的那几天。
 */
export function spread(
  amounts: ReadonlyMap<string, number>,
  now: Date,
  span: number,
): readonly ActivityDay[] {
  const days: ActivityDay[] = []

  for (let index = span - 1; index >= 0; index -= 1) {
    const date = dayKeyOf(shiftDays(now, -index))

    days.push({ date, count: amounts.get(date) ?? 0 })
  }

  return days
}

/** 一段日子里的单日最高。热力图拿它当分档上界。 */
export function busiestOf(days: readonly ActivityDay[]): number {
  return days.reduce((most, day) => Math.max(most, day.count), 0)
}

/** 这一天该画第几档。0 是「这天没有」，其余按占单日最高的比例分。 */
export function levelOf(count: number, busiest: number): number {
  if (count <= 0 || busiest <= 0) {
    return 0
  }

  return Math.max(1, Math.ceil((count / busiest) * 4))
}

/** 把一串时刻按天点数。坏时刻算出来的键谁也匹配不上，自己就消失了。 */
function countBy(times: readonly string[]): ReadonlyMap<string, number> {
  const counted = new Map<string, number>()

  for (const time of times) {
    const key = dayKeyOf(new Date(time))

    counted.set(key, (counted.get(key) ?? 0) + 1)
  }

  return counted
}

/*
 * 连续天数从哪一头起算。
 *
 * 今天还没有活动时从昨天算起，而不是当场归零：计数器的通行读法是「到目前为止
 * 连续了几天」，早上八点把昨天以前的成绩清掉，说的不是同一件事。
 *
 * 它不受窗口约束 —— 连续了多少天是一个事实，不是一个视图。
 */
function streakOf(counted: ReadonlyMap<string, number>, today: Date): number {
  const offset = counted.has(dayKeyOf(today)) ? 0 : 1
  let length = 0

  while (counted.has(dayKeyOf(shiftDays(today, -(offset + length))))) {
    length += 1
  }

  return length
}

/** 概览：一串对话的最后活动时刻，落在最近 span 天里是什么样。 */
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
