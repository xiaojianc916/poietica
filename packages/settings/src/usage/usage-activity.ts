/*
 * 用量页的算术：一串活动时刻，一串按天计数。
 *
 * 这一段不认识 React，也不认识 ThreadsStore：进来的是 ISO 时刻，出去的是数。
 * 页面换了它不必跟着换，测试也不需要先挂一棵组件树。
 *
 * 日历分两半：对内索引用本地日历字段，对外显示用 Intl。索引不能借某个 locale
 * 的短日期格式当键 —— 那是排版，不是标识；显示也不能自己拼，那是手搓国际化。
 *
 * 跨天加减一律走 Date 构造器的溢出归一，不用 86_400_000 乘法：夏令时那天只有
 * 23 小时，乘法会把整张图错开一格。
 */

/** 一天，以及那天有多少条对话在活动。 */
export interface ActivityDay {
  readonly date: string
  readonly count: number
}

/** 一个区间的活动全貌。页面上每一个真数字都出自这里。 */
export interface ActivitySummary {
  /** 区间内每一天，含没有活动的那些；由早到晚。 */
  readonly days: readonly ActivityDay[]
  /** 区间内有过活动的对话条数。 */
  readonly threads: number
  /** 其中有活动的天数。 */
  readonly activeDays: number
  /** 到今天为止连续有活动的天数。 */
  readonly streak: number
  /** 单日最高，热力图拿它当分档上界。 */
  readonly busiest: number
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

/** 这一天该画第几档。0 是「这天没有」，其余按占单日最高的比例分。 */
export function levelOf(count: number, busiest: number): number {
  if (count <= 0 || busiest <= 0) {
    return 0
  }

  return Math.max(1, Math.ceil((count / busiest) * 4))
}

/*
 * 连续天数从哪一头起算。
 *
 * 今天还没有活动时从昨天算起，而不是当场归零：计数器的通行读法是「到目前为止
 * 连续了几天」，早上八点把昨天以前的成绩清掉，说的不是同一件事。
 *
 * 它不受区间约束 —— 连续了多少天是一个事实，不是一个视图。
 */
function streakOf(counted: ReadonlyMap<string, number>, today: Date): number {
  const offset = counted.has(dayKeyOf(today)) ? 0 : 1
  let length = 0

  while (counted.has(dayKeyOf(shiftDays(today, -(offset + length))))) {
    length += 1
  }

  return length
}

/*
 * 时刻表 → 区间内的按天计数。
 *
 * 坏时刻不需要一句判空：它算出来的键谁也匹配不上，自己就消失了。
 */
export function summarize(times: readonly string[], now: Date, span: number): ActivitySummary {
  const counted = new Map<string, number>()

  for (const time of times) {
    const key = dayKeyOf(new Date(time))

    counted.set(key, (counted.get(key) ?? 0) + 1)
  }

  const days: ActivityDay[] = []
  let threads = 0
  let activeDays = 0
  let busiest = 0

  for (let index = span - 1; index >= 0; index -= 1) {
    const date = dayKeyOf(shiftDays(now, -index))
    const count = counted.get(date) ?? 0

    days.push({ date, count })
    threads += count
    activeDays += count > 0 ? 1 : 0
    busiest = Math.max(busiest, count)
  }

  return { days, threads, activeDays, streak: streakOf(counted, now), busiest }
}
