import { describe, expect, it } from 'bun:test'
import {
  busiestOf,
  dayKeyOf,
  formatTokens,
  levelOf,
  modelSeries,
  shiftDays,
  spread,
  spreadWeeks,
  summarize,
  weekdayOf,
} from './usage-activity'

/*
 * 全部用本地时刻构造，所以在任何时区下结论相同：日历索引读的就是本地日历字段。
 */

describe('用量统计', () => {
  it('概览把每条对话记在它最后活动的那一天', () => {
    const now = new Date(2026, 7, 11)

    const times = [
      new Date(2026, 7, 11, 9).toISOString(),
      new Date(2026, 7, 11, 21).toISOString(),
      new Date(2026, 7, 9, 13).toISOString(),
    ]

    const overview = summarize(times, now, 7)

    expect(overview.threads).toBe(3)
    expect(overview.activeDays).toBe(2)
  })

  it('窗口之外的对话不进概览', () => {
    const now = new Date(2026, 7, 11)
    const times = [new Date(2026, 6, 20, 9).toISOString()]

    expect(summarize(times, now, 7).threads).toBe(0)
    expect(summarize(times, now, 30).threads).toBe(1)
  })

  it('今天还没有活动时，连续天数从昨天起算', () => {
    const now = new Date(2026, 7, 11)
    const times = [new Date(2026, 7, 10, 8).toISOString(), new Date(2026, 7, 9, 8).toISOString()]

    expect(summarize(times, now, 30).streak).toBe(2)
  })

  /*
   * 两端都必须是满的：正本 zcode 把日历按自然周补齐（buildDisplayHeatmapWeeks），
   * 第一行是周日、末列到周六结束。缺哪一端，图上就是半截一列。
   */
  it('热力图日历从周日开始、到周六结束，正好整周', () => {
    const days = spreadWeeks(new Map(), new Date(2026, 7, 11), 26)

    expect(days).toHaveLength(26 * 7)
    expect(weekdayOf(days[0]?.date ?? '')).toBe(0)
    expect(weekdayOf(days.at(-1)?.date ?? '')).toBe(6)
  })

  /*
   * 今天必须落在**最后一行**（周六那一行）：对齐到周日开头之后，周六是第 7 行。
   * 周一记 0 的话它会落到倒数第二行 —— 屏幕上就是「最新一天不在最下面」。
   */
  it('最后一天落在最后一行，与它的星期几一致', () => {
    const now = new Date(2026, 9, 3)
    const days = spreadWeeks(new Map(), now, 26)
    const last = days.at(-1)

    expect(last?.date).toBe(dayKeyOf(now))
    expect(weekdayOf(last?.date ?? '')).toBe(6)
  })

  it('空账也铺满整段日历，且全是最低档', () => {
    const days = spread(new Map(), new Date(2026, 7, 11), 182)

    expect(days).toHaveLength(182)
    expect(busiestOf(days)).toBe(0)
    expect(days.at(-1)).toEqual({ date: '2026-08-11', count: 0 })
  })

  it('有账的日子按账走', () => {
    const ledger = new Map([['2026-08-10', 12_000]])
    const days = spread(ledger, new Date(2026, 7, 11), 2)

    expect(days).toEqual([
      { date: '2026-08-10', count: 12_000 },
      { date: '2026-08-11', count: 0 },
    ])
  })

  it('跨月回退不会错开一天', () => {
    expect(dayKeyOf(shiftDays(new Date(2026, 7, 1), -1))).toBe('2026-07-31')
  })

  /* 周日记 0，与 Date.getDay 同序：热力图第一行是周日。 */
  it('日期键按本地零点读回，周日记 0', () => {
    expect(weekdayOf('2026-08-11')).toBe(2)
    expect(weekdayOf('2026-08-16')).toBe(0)
  })

  it('没有活动的一天不占档位', () => {
    expect(levelOf(0, 4)).toBe(0)
    expect(levelOf(1, 4)).toBe(1)
    expect(levelOf(4, 4)).toBe(4)
  })
})

describe('按模型的趋势', () => {
  const rows = [
    { day: '2026-08-10', model: 'a/one', tokens: 100 },
    { day: '2026-08-11', model: 'a/one', tokens: 50 },
    { day: '2026-08-11', model: 'b/two', tokens: 900 },
  ]

  /* 主力模型排最前，判据是这段日子里的总量而不是单日最高。 */
  it('按总量排序，天天在用的压过只冲高一天的', () => {
    expect(modelSeries(rows, new Date(2026, 7, 11), 2).map((line) => line.model)).toEqual([
      'b/two',
      'a/one',
    ])
  })

  /* 每条线都铺满同一段日历：各自只铺有账的那几天会把两条线错开。 */
  it('每条线都对齐到同一段日历', () => {
    const [first] = modelSeries(rows, new Date(2026, 7, 11), 3)

    expect(first?.days).toEqual([
      { date: '2026-08-09', count: 0 },
      { date: '2026-08-10', count: 0 },
      { date: '2026-08-11', count: 900 },
    ])
  })
})

describe('Token 数怎么报', () => {
  it('不到一千原样报，不带档位', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('千位起用 K，留一位小数', () => {
    expect(formatTokens(1_000)).toBe('1.0K')
    expect(formatTokens(12_345)).toBe('12.3K')
    expect(formatTokens(999_949)).toBe('999.9K')
  })

  it('百万起用 M，留两位小数', () => {
    expect(formatTokens(1_000_000)).toBe('1.00M')
    expect(formatTokens(65_387_174)).toBe('65.39M')
    expect(formatTokens(70_322_477)).toBe('70.32M')
  })

  /* 进位那一格：1000.0K 是四位整数带一个小数，量级反而读不出来。 */
  it('K 会进位成 1000.0K 时改用 M', () => {
    expect(formatTokens(999_950)).toBe('1.00M')
    expect(formatTokens(999_999)).toBe('1.00M')
  })
})
