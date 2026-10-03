import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { ModelTrend, spendOf } from './model-trend'
import type { ModelSeries } from './usage-activity'

const STYLES = readFileSync(new URL('./surface/settings-surface.css', import.meta.url), 'utf8')

/*
 * 守三条：一个模型一条线、**平时不画点**（常驻的点会把折线读成一串珠子），
 * 以及图例写的是模型名而不是账上的 provider/id。
 *
 * 悬浮那三样是运行期状态，静态渲染里一个都不该有 —— 这同时也是「平时不画点」
 * 的判据：点只在指针在场时才存在。
 */
const SERIES: readonly ModelSeries[] = [
  {
    model: 'a/one',
    label: '第一个模型',
    days: [
      { date: '2026-08-10', count: 0 },
      { date: '2026-08-11', count: 100 },
    ],
  },
  {
    model: 'b/two',
    label: '第二个模型',
    days: [
      { date: '2026-08-10', count: 50 },
      { date: '2026-08-11', count: 0 },
    ],
  },
]

describe('每日 Token 趋势图', () => {
  it('一个模型一条折线', () => {
    const markup = renderToStaticMarkup(<ModelTrend series={SERIES} />)

    expect(markup.match(/settings-trend__line/g)).toHaveLength(2)
  })

  it('平时不画点、不画竖线、不弹气泡', () => {
    const markup = renderToStaticMarkup(<ModelTrend series={SERIES} />)

    expect(markup).not.toContain('settings-trend__point')
    expect(markup).not.toContain('settings-trend__guide')
    expect(markup).not.toContain('settings-trend__hint')
  })

  it('图例写的是模型名，不是账上的 provider/id', () => {
    const markup = renderToStaticMarkup(<ModelTrend series={SERIES} />)

    expect(markup).toContain('第一个模型')
    expect(markup).not.toContain('a/one')
  })

  /* 图例只有名字：常驻的总量是重复信息，已按产品要求删掉。 */
  it('图例不带用量数字', () => {
    const markup = renderToStaticMarkup(<ModelTrend series={SERIES} />)

    expect(markup).not.toContain('settings-trend__total')
  })

  /* 横轴按百分比落位：给固定像素会让 30 列宽出卡片，把整页撑破。 */
  it('横轴按百分比落位，不给固定像素', () => {
    const markup = renderToStaticMarkup(<ModelTrend series={SERIES} />)

    expect(markup).not.toContain('inline-size:')
  })

  /*
   * 日期按折线上那一点的横坐标落位，与点数无关地铺满同一段：首末贴住两端留白，
   * 中间等分。按格心算的话 7 天要多缩半格（6.8%）而 30 天只缩 1.6% ——
   * 7 天的七个日期就会全挤在中间，两档看着不像同一张图。
   */
  it('7 天与 30 天的日期铺满同一段，首末贴边', () => {
    const positions = (length: number) => {
      const days = Array.from({ length }, (_, index) => ({
        date: `2026-09-${String(index + 1).padStart(2, '0')}`,
        count: index,
      }))
      const markup = renderToStaticMarkup(
        <ModelTrend series={[{ model: 'a/one', label: '第一个模型', days }]} />,
      )
      const axis = markup.slice(markup.indexOf('settings-trend__axis'))

      return [...axis.matchAll(/left:([\d.]+)%/g)].map((match) => Number(match[1]))
    }

    const week = positions(7)
    const month = positions(30)

    expect(week).toHaveLength(7)
    expect(month).toHaveLength(7)
    expect(week[0]).toBeCloseTo(month[0] as number, 5)
    expect(week.at(-1)).toBeCloseTo(month.at(-1) as number, 5)
    /* 末点必须贴住右端留白，而不是缩进半格。 */
    expect(week.at(-1)).toBeGreaterThan(97)
  })

  /*
   * 30 天时末尾那一列正好落在步长之外，漏掉的话最后一天在轴上没有名字
   * （正本 zcode 的 shouldShowXAxisLabel 把首尾单独拎出来判）。
   */
  it('日期多的时候末尾那天照样写出来', () => {
    const days = Array.from({ length: 30 }, (_, index) => ({
      date: `2026-09-${String(index + 1).padStart(2, '0')}`,
      count: index,
    }))
    const markup = renderToStaticMarkup(
      <ModelTrend series={[{ model: 'a/one', label: '第一个模型', days }]} />,
    )

    expect(markup).toContain('9/30')
  })

  /*
   * 刻度数两档必须一样多：正本 zcode 的步长是写死的 5（超过 45 天才是 7），
   * 按「想要几个」反算的话 30 天会得 4，屏幕上就是 9 个刻度而 7 天是 7 个。
   */
  it('7 天与 30 天写出的日期个数一样', () => {
    const count = (length: number) => {
      const days = Array.from({ length }, (_, index) => ({
        date: `2026-09-${String(index + 1).padStart(2, '0')}`,
        count: index,
      }))
      const markup = renderToStaticMarkup(
        <ModelTrend series={[{ model: 'a/one', label: '第一个模型', days }]} />,
      )

      return (markup.match(/settings-trend__axis"[\s\S]*?<\/p>/)?.[0].match(/\d+\/\d+/g) ?? [])
        .length
    }

    expect(count(7)).toBe(7)
    expect(count(30)).toBe(7)
  })

  /* 折线是单调三次曲线，不是直连的折线：拐弯处不该有尖角。 */
  it('折线走贝塞尔曲线，不是直线段', () => {
    const markup = renderToStaticMarkup(<ModelTrend series={SERIES} />)

    expect(markup).toContain(' C ')
  })
})

/*
 * 竖虚线只在**这一天真的花过 token** 时才画：它是一条读数辅助线，指到空账上什么也
 * 读不出来，反而像在说那天有数据。圆点照画 —— 它们标的是折线此刻的位置。
 *
 * 判据与气泡用的是同一个 spendOf：一处说有一天说没有，屏幕上就会自相矛盾。
 */
describe('竖虚线只画在有数据的那一天', () => {
  const series: readonly ModelSeries[] = [
    {
      model: 'a/one',
      label: '第一个模型',
      days: [
        { date: '2026-08-10', count: 0 },
        { date: '2026-08-11', count: 100 },
      ],
    },
  ]

  it('空账那天判成没有数据，有账那天判成有', () => {
    expect(spendOf(series, 0)).toHaveLength(0)
    expect(spendOf(series, 1)).toHaveLength(1)
  })

  /* 判据同源：气泡列的就是 spendOf 的返回，所以两者不会互相矛盾。 */
  it('气泡列的行与判据是同一份', () => {
    expect(spendOf(series, 1)[0]?.tokens).toBe(100)
  })
})

/*
 * 悬浮层盖在图上，吃指针事件的话：指针一进悬浮层 → SVG 收到 mouseleave → 悬浮态
 * 清掉 → 这一层卸载 → 指针又落回 SVG。屏幕上就是「显示一下就没、还剧烈抖动」。
 * 这条守的是整层与层里每一样都不吃事件。
 */
describe('悬浮层不吃指针事件', () => {
  it('覆盖层与它里面的每一样都是 pointer-events: none', () => {
    /* 深色那支是 .settings-trend__hint 的覆盖规则，只改配色，不参与这一条。 */
    const base = STYLES.split('\n')
      .filter((line) => !line.startsWith(':root'))
      .join('\n')
    const rules = base.match(/\.settings-trend__(overlay|guide|point|hint)\s*\{[^}]*\}/g) ?? []

    expect(rules).toHaveLength(4)

    for (const rule of rules) {
      expect(rule).toContain('pointer-events: none')
    }
  })
})
