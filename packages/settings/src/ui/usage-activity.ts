/*
 * 用量页的算术：一本按天的账铺成日历，或一串时刻点成概览。
 * 不认识 React 也不认识 ThreadsStore：进来的是数据，出去的是数。
 * 索引用本地日历字段（dayKeyOf），显示用 Intl —— locale 的短日期格式是排版不是标识。
 * 跨天加减走 Date 构造器的溢出归一：夏令时那天只有 23 小时，86_400_000 乘法会错一格。
 */

/** 一天，以及那天的量。量是什么由调用方决定 —— 热力图喂的是 token。 */
export interface ActivityDay {
  readonly date: string
  readonly count: number
}

/** 日账的一行：键是日历日（YYYY-MM-DD），值是那天的 token 数。 */
export interface UsageLedgerDay {
  readonly day: string
  readonly tokens: number
}

/** 按模型拆开的日账的一行。 */
export interface UsageModelDay {
  readonly day: string
  readonly model: string
  readonly tokens: number
}

/**
 * 读最近 span 天的日账，由组合根注入。
 *
 * 与 appVersion / dataDirectory 同一条理由：账本只有原生侧那一份，而这一层不认识桌面传输层。
 */
export type ReadTokenDays = (span: number) => Promise<readonly UsageLedgerDay[]>

/** 读最近 span 天按模型拆开的日账。 */
export type ReadModelDays = (span: number) => Promise<readonly UsageModelDay[]>

/** 读最近 span 天发出去的句子数。 */
export type ReadMessageCount = (span: number) => Promise<number>

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

/* 键读回时刻必须补 T00:00:00：纯日期字符串按 UTC 解析，UTC 以西的时区会读成前一天。 */
export function dateOf(key: string): Date {
  return new Date(`${key}T00:00:00`)
}

/** 从这一天起算的第 delta 天。溢出由 Date 自己归一。 */
export function shiftDays(from: Date, delta: number): Date {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + delta)
}

/**
 * 这一天是周几，**周日记 0**，与 Date.getDay 同序。
 *
 * 热力图的第一行是周日（正本 zcode 的自然周对齐：buildDisplayHeatmapWeeks 用
 * getUtcWeekday 起算，注释写明「保证所有范围的第一行都是周日」）。周一记 0 的话
 * 每一格都要错开一行 —— 周六会落到倒数第二行，而它本该在最下面。
 */
export function weekdayOf(key: string): number {
  return dateOf(key).getDay()
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

/** 一条线：一个模型，以及它在这段日子里的逐日量。 */
export interface ModelSeries {
  /** 账上的名字（provider/id）。取值与选择器那一格同一拼法。 */
  readonly model: string
  /** 屏幕上的名字。由调用方从 agent 自己的模型目录取，取不到就退回 model。 */
  readonly label: string
  readonly days: readonly ActivityDay[]
}

/**
 * 把按模型拆开的日账铺成一条条线，每条都对齐到同一段日历。
 *
 * 线与线的日子必须等长同序：图是按横轴对齐画的，缺的日子由 spread 补 0，
 * 各自只铺自己有账的那几天就会把两条线错开。
 *
 * 排序是「这段日子里的总量」，不是单日最高：趋势图要的是主力模型在最上面，
 * 而一个只在某一天冲高的模型不该压过天天在用的那个。
 */
export function modelSeries(
  rows: readonly UsageModelDay[],
  now: Date,
  span: number,
): readonly ModelSeries[] {
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

/**
 * 把一本按天的账铺成**整周**：周一开头、周日结尾，不多不少 weeks 列。
 *
 * 热力图一列一周、周一在最上面，直接铺 N 天的话第一列从半空开始、最后一列半截
 * 收尾，两端各缺一块。正本 zcode 的 UsageHeatmap 就是把日历按自然周对齐后补齐
 * 0 格（buildDisplayHeatmapWeeks），两端因此都是满的。
 *
 * 补出来的格子是「这段日历里没有账」，与「这天没花」画的是同一格 —— 热力图看的
 * 是形状，不是账目明细。
 */
export function spreadWeeks(
  amounts: ReadonlyMap<string, number>,
  now: Date,
  weeks: number,
): readonly ActivityDay[] {
  /* 末列是本周（含今天往后到周日）：右端因此也是满的，不会半截收尾。 */
  const end = shiftDays(now, 6 - weekdayOf(dayKeyOf(now)))
  const days: ActivityDay[] = []

  for (let index = weeks * 7 - 1; index >= 0; index -= 1) {
    const date = dayKeyOf(shiftDays(end, -index))

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

const THOUSAND = 1_000
const MILLION = 1_000_000

/** 不到一千的数原样报，分组由平台给。 */
const PLAIN = new Intl.NumberFormat('zh-CN')

/* K 阈值取一位小数的进位点，避免显示「1000.0K」。 */
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
 * 今天还没活动时从昨天算起，而不是当场归零：计数器的通行读法是「到目前为止
 * 连续了几天」，早上八点把昨天以前的成绩清掉说的不是同一件事。不受窗口约束。
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
