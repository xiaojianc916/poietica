import { describe, expect, it } from 'bun:test'

import { DAY, HOUR, MINUTE } from '../semantics/duration'
import {
  datedGroupsOf,
  formatAbsolute,
  formatElapsed,
  instantsOf,
  nextChangeIn,
  paintedGroupsOf,
} from '../threads/relative-time'

/*
 * 一个固定的本地时刻，远离午夜：期限那几条要跨过分钟与小时的边界，而不该
 * 顺带撞上「下一个本地午夜」那条无条件的边界。
 */
const noon = new Date(2026, 7, 4, 12, 0, 0, 0).getTime()

const midnightAfter = (instant: number): number => {
  const at = new Date(instant)

  at.setHours(0, 0, 0, 0)
  at.setDate(at.getDate() + 1)

  return at.getTime()
}

const row = (updatedAt: string) => ({ updatedAt })

describe('formatElapsed', () => {
  /*
   * 不足一分钟是一句话，不是「0 分钟」。这一档由 RelativeTimeFormat 的
   * numeric: 'auto' 说，所以这里只断言「同一句话」，不断言那句话是什么。
   */
  it('一分钟之内始终是同一句话', () => {
    expect(formatElapsed(noon, noon)).toBe(formatElapsed(noon - 30 * 1000, noon))
    expect(formatElapsed(noon - (MINUTE - 1), noon)).toBe(formatElapsed(noon, noon))
  })

  /* 时钟偏差会给出未来时刻。它读作「现在」，不是一个负数。 */
  it('未来时刻读作现在', () => {
    expect(formatElapsed(noon + 5 * MINUTE, noon)).toBe(formatElapsed(noon, noon))
  })

  /*
   * 一周是时长与日期的分界：时长在近处有用，在远处只剩噪声。两侧各取一个
   * 样本，断言它们不是同一种说法 —— 具体的词由平台给。
   */
  it('一周之内给时长，更久给日期', () => {
    const withinWeek = formatElapsed(noon - 3 * DAY, noon)
    const beyondWeek = formatElapsed(noon - 30 * DAY, noon)

    expect(withinWeek).not.toBe(beyondWeek)

    /* 更久的那一档是一个日期，所以它一定带着这一天的号数。 */
    expect(beyondWeek).toContain(String(new Date(noon - 30 * DAY).getDate()))
  })

  /* 跨年的那一档要带上年份，否则「3月2日」是哪一年说不清。 */
  it('跨年的日期带上年份', () => {
    const lastYear = new Date(2025, 2, 2, 12, 0, 0, 0).getTime()

    expect(formatElapsed(lastYear, noon)).toContain('2025')
  })
})

describe('nextChangeIn', () => {
  /*
   * 午夜无条件算进去：跨过它，一天以上的那些行要一起改口，哪怕列表是空的。
   * 一天以上没有属于自己的期限，这正是它交回 Infinity 的意思。
   */
  it('空列表也在下一个午夜到期', () => {
    expect(nextChangeIn([], noon)).toBe(midnightAfter(noon))
  })

  it('一天以上的行不自带期限，仍然只等午夜', () => {
    expect(nextChangeIn([noon - 5 * DAY], noon)).toBe(midnightAfter(noon))
  })

  /* 一分钟之内的那一行，在它自己那一分钟满的时候改口。 */
  it('取最近的那一行的边界', () => {
    const fresh = noon - 10 * 1000

    expect(nextChangeIn([fresh, noon - 5 * DAY], noon)).toBe(fresh + MINUTE)
  })

  it('小时那一档在下一个整点差改口', () => {
    const instant = noon - (2 * HOUR + 15 * MINUTE)

    expect(nextChangeIn([instant], noon)).toBe(instant + 3 * HOUR)
  })

  /* 解析不出来的时刻不参与期限：它那一行根本不画时间。 */
  it('跳过解析不出来的时刻', () => {
    expect(nextChangeIn([Number.NaN], noon)).toBe(midnightAfter(noon))
  })
})

describe('两级投影', () => {
  const groups = [
    {
      id: 'D:\\\\xiaojianc',
      name: 'xiaojianc',
      items: [row('2026-08-04T03:00:00.000Z'), row('not a date')],
    },
    { id: 'default', name: null, items: [row('2026-08-03T03:00:00.000Z')] },
  ]

  /*
   * 时刻与绝对文案只是 updatedAt 的函数，所以它们算在这一趟：时钟跳一次
   * 不该让整屏重跑一遍 Date.parse 与 dateStyle: 'full'。
   */
  it('数据那一趟给出时刻与准确说法', () => {
    const dated = datedGroupsOf(groups)
    const first = dated[0]?.members[0]

    expect(first?.instant).toBe(Date.parse('2026-08-04T03:00:00.000Z'))
    expect(first?.absolute).toBe(formatAbsolute(Date.parse('2026-08-04T03:00:00.000Z')))
  })

  /* 解析不出来的时刻不编一个：NaN 与 null，而不是 0 与一句假话。 */
  it('解析不出来的时刻不被编造', () => {
    const broken = datedGroupsOf(groups)[0]?.members[1]

    expect(Number.isNaN(broken?.instant ?? 0)).toBe(true)
    expect(broken?.absolute).toBeNull()
  })

  /*
   * 没有名字的那一组原样带过。补一个名字，无论补在哪一层，都是同一个编造 ——
   * 界面据此决定不画组头，而不是画一个用户找不到的地方。
   */
  it('没有名字的那一组两趟都不被补名', () => {
    const dated = datedGroupsOf(groups)

    expect(dated[1]?.name).toBeNull()
    expect(paintedGroupsOf(dated, noon)[1]?.name).toBeNull()
  })

  it('时钟那一趟只添相对文案，时刻与准确说法原样带过', () => {
    const dated = datedGroupsOf(groups)
    const painted = paintedGroupsOf(dated, noon)
    const before = dated[0]?.members[0]
    const after = painted[0]?.members[0]

    expect(after?.instant).toBe(before?.instant)
    expect(after?.absolute).toBe(before?.absolute)
    expect(after?.elapsed).toBe(formatElapsed(before?.instant ?? 0, noon))
  })

  it('解析不出来的那一行不画时间', () => {
    expect(paintedGroupsOf(datedGroupsOf(groups), noon)[0]?.members[1]?.elapsed).toBeNull()
  })

  /* 期限要的是整屏所有行的时刻，跨组拉平。 */
  it('时刻跨组拉平交给期限', () => {
    expect(instantsOf(datedGroupsOf(groups))).toHaveLength(3)
  })
})
