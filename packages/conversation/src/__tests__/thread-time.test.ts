import { describe, expect, it } from 'bun:test'

import { DAY, HOUR, MINUTE } from '../surface/semantics/duration'
import {
  datedGroupsOf,
  formatAbsolute,
  formatElapsed,
  instantsOf,
  nextChangeIn,
  paintedGroupsOf,
} from '../surface/threads/relative-time'

/* noon 远离午夜：期限用例要跨分钟/小时边界，不能顺带撞上「下一个本地午夜」。 */
const noon = new Date(2026, 7, 4, 12, 0, 0, 0).getTime()

const midnightAfter = (instant: number): number => {
  const at = new Date(instant)

  at.setHours(0, 0, 0, 0)
  at.setDate(at.getDate() + 1)

  return at.getTime()
}

const row = (updatedAt: string) => ({ updatedAt })

describe('formatElapsed', () => {
  /* 措辞由 Intl.RelativeTimeFormat 的 numeric:'auto' 定，只断言同一句话。 */
  it('一分钟之内始终是同一句话', () => {
    expect(formatElapsed(noon, noon)).toBe(formatElapsed(noon - 30 * 1000, noon))
    expect(formatElapsed(noon - (MINUTE - 1), noon)).toBe(formatElapsed(noon, noon))
  })

  it('未来时刻读作现在', () => {
    expect(formatElapsed(noon + 5 * MINUTE, noon)).toBe(formatElapsed(noon, noon))
  })

  it('一周之内给时长，更久给日期', () => {
    const withinWeek = formatElapsed(noon - 3 * DAY, noon)
    const beyondWeek = formatElapsed(noon - 30 * DAY, noon)

    expect(withinWeek).not.toBe(beyondWeek)

    expect(beyondWeek).toContain(String(new Date(noon - 30 * DAY).getDate()))
  })

  it('跨年的日期带上年份', () => {
    const lastYear = new Date(2025, 2, 2, 12, 0, 0, 0).getTime()

    expect(formatElapsed(lastYear, noon)).toContain('2025')
  })
})

describe('nextChangeIn', () => {
  it('空列表也在下一个午夜到期', () => {
    expect(nextChangeIn([], noon)).toBe(midnightAfter(noon))
  })

  it('一天以上的行不自带期限，仍然只等午夜', () => {
    expect(nextChangeIn([noon - 5 * DAY], noon)).toBe(midnightAfter(noon))
  })

  it('取最近的那一行的边界', () => {
    const fresh = noon - 10 * 1000

    expect(nextChangeIn([fresh, noon - 5 * DAY], noon)).toBe(fresh + MINUTE)
  })

  it('小时那一档在下一个整点差改口', () => {
    const instant = noon - (2 * HOUR + 15 * MINUTE)

    expect(nextChangeIn([instant], noon)).toBe(instant + 3 * HOUR)
  })

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

  it('数据那一趟给出时刻与准确说法', () => {
    const dated = datedGroupsOf(groups)
    const first = dated[0]?.members[0]

    expect(first?.instant).toBe(Date.parse('2026-08-04T03:00:00.000Z'))
    expect(first?.absolute).toBe(formatAbsolute(Date.parse('2026-08-04T03:00:00.000Z')))
  })

  it('解析不出来的时刻不被编造', () => {
    const broken = datedGroupsOf(groups)[0]?.members[1]

    expect(Number.isNaN(broken?.instant ?? 0)).toBe(true)
    expect(broken?.absolute).toBeNull()
  })

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

  it('时刻跨组拉平交给期限', () => {
    expect(instantsOf(datedGroupsOf(groups))).toHaveLength(3)
  })
})
