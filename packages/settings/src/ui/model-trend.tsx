import { type CSSProperties, type MouseEvent, useState } from 'react'
import { busiestOf, dateOf, formatTokens, type ModelSeries } from './usage-activity'

/*
 * 每日 Token 趋势图：一个模型一条线，横轴是这段日历，纵轴按这段日子的单日最高定。
 *
 * 折线走 SVG，不引图表库（正本 zcode 用了 recharts，本仓不为此装一个库）：这里只有
 * 网格与折线两样，装一个图表库换来的是它整套排版与主题。
 *
 * **悬浮的三样（竖线、点、数值气泡）由同一个指针位置算出**，不各挂一套监听：三样
 * 同源才不会出现「气泡在这一列、点在那一列」，也不会因气泡自己的开合延时抖。
 * 平时只画线 —— 三十个点常驻会把折线读成一串珠子，而这里要看的是走势。
 *
 * 悬浮那三样走 HTML 而不是 SVG：SVG 被 preserveAspectRatio="none" 横向拉伸，画在
 * 里面的圆会变成椭圆、虚线间距也会跟着变形。按百分比定位的 HTML 层与拉伸后的坐标
 * 系是同一套线性映射，圆永远是圆、线永远是 1px。
 */

const WIDTH = 1000
const HEIGHT = 240
/* 上下各留一截：线不贴着框，最高那天也不顶到上沿。 */
const PAD_Y = 16

/*
 * 左右各留一截，与正本 zcode 的图表 margin 同一个用意（它给 {top:8,right:24,left:24}）：
 * 首尾两个点正落在绘图区边界上时，日期文字与最后一个点会被容器裁掉一半。
 * 这里写成比例，因为本仓的横轴是等分格而不是固定像素。
 */
const INSET_SHARE = 0.025

/** 六档色轮转，与正本 zcode 的 usage chart 色板同序。 */
const SERIES_INKS = 6

/** 这个天数以内横轴每天都写；再多按固定步长抽（正本 zcode 的判据同值）。 */
const AXIS_LABELS = 14

const AXIS_DATE = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' })

/** 纵轴的四条虚线：0 与单日最高之间等分。 */
const GRID = [0, 1, 2, 3, 4] as const

interface Spot {
  readonly x: number
  readonly y: number
}

/**
 * 第 index 个点的横坐标（viewBox 坐标）：首点贴左界、末点贴右界，中间等分。
 *
 * **不是格心**。按格心算的话每一列都要再内缩半格，而半格是随天数变的：7 天时占
 * 6.8%、30 天时只占 1.6%，于是 7 天的七个日期全挤在中间，30 天的却铺得开 ——
 * 两档看着不像同一张图。正本 zcode 的 recharts 分类轴也是首末贴边（scalePoint），
 * 所以这里按 (count - 1) 等分。
 */
function xOf(index: number, count: number): number {
  const span = 1 - INSET_SHARE * 2
  const share = count <= 1 ? 0.5 : index / (count - 1)

  return WIDTH * (INSET_SHARE + span * share)
}

/** 一个数在绘图区里的位置，0（底）到 1（顶）。 */
function ratioOf(count: number, busiest: number): number {
  return busiest <= 0 ? 0 : count / busiest
}

/** 第 index 个点的纵坐标（viewBox 坐标）。 */
function yOf(count: number, busiest: number): number {
  return HEIGHT - PAD_Y - ratioOf(count, busiest) * (HEIGHT - PAD_Y * 2)
}

function spotsOf(series: ModelSeries, busiest: number): readonly Spot[] {
  return series.days.map((day, index) => ({
    x: xOf(index, series.days.length),
    y: yOf(day.count, busiest),
  }))
}

/*
 * 单调三次插值（Fritsch–Carlson）→ 三次贝塞尔路径，分三步。
 *
 * 正本 zcode 的折线是 recharts 的 type="monotone"，本仓不引那个库，所以这一小段
 * 自己算：折线直接连点会在数据拐弯处留下生硬的尖角，而单调插值既把拐角磨圆，又
 * **不会在两点之间插出多余的峰谷**（普通样条会，屏幕上就是一条凭空冒出来的波动）。
 */

/** 相邻两点的斜率。 */
function segmentSlopes(spots: readonly Spot[]): readonly number[] {
  const deltas: number[] = []

  for (let index = 0; index < spots.length - 1; index += 1) {
    const left = spots[index] as Spot
    const right = spots[index + 1] as Spot
    const run = right.x - left.x || 1

    deltas.push((right.y - left.y) / run)
  }

  return deltas
}

/** 每个点上的切线斜率：Fritsch–Carlson 的三条约束（保单调、拐点归零、限幅）。 */
function monotoneSlopes(deltas: readonly number[]): readonly number[] {
  const slopes: number[] = [deltas[0] ?? 0]

  for (let index = 1; index < deltas.length; index += 1) {
    const previous = deltas[index - 1] ?? 0
    const next = deltas[index] ?? 0

    slopes.push(previous * next <= 0 ? 0 : (previous + next) / 2)
  }
  slopes.push(deltas.at(-1) ?? 0)

  for (let index = 0; index < deltas.length; index += 1) {
    const delta = deltas[index] ?? 0

    if (delta === 0) {
      slopes[index] = 0
      slopes[index + 1] = 0
      continue
    }

    const alpha = (slopes[index] ?? 0) / delta
    const beta = (slopes[index + 1] ?? 0) / delta
    const square = alpha * alpha + beta * beta

    if (square > 9) {
      const scale = 3 / Math.sqrt(square)

      slopes[index] = scale * alpha * delta
      slopes[index + 1] = scale * beta * delta
    }
  }

  return slopes
}

function monotonePath(spots: readonly Spot[]): string {
  const first = spots[0]

  if (first === undefined) {
    return ''
  }

  if (spots.length === 1) {
    return `M ${first.x.toFixed(1)} ${first.y.toFixed(1)}`
  }

  const slopes = monotoneSlopes(segmentSlopes(spots))
  let path = `M ${first.x.toFixed(1)} ${first.y.toFixed(1)}`

  for (let index = 0; index < spots.length - 1; index += 1) {
    const left = spots[index] as Spot
    const right = spots[index + 1] as Spot
    const run = (right.x - left.x) / 3
    const out = (slopes[index] ?? 0) * run
    const into = (slopes[index + 1] ?? 0) * run

    path += ` C ${(left.x + run).toFixed(1)} ${(left.y + out).toFixed(1)}, ${(right.x - run).toFixed(1)} ${(right.y - into).toFixed(1)}, ${right.x.toFixed(1)} ${right.y.toFixed(1)}`
  }

  return path
}

/*
 * 横轴上要写日期的那几列。判据逐字取正本 zcode 的 shouldShowDailyChartAxisLabel：
 * 两周以内全写；再长按固定步长（超过 45 天用 7，否则 5），首尾必写。
 *
 * 步长写死而不是按「想要几个」反算：反算出来的步长会随天数变化（30 天得 4、31 天
 * 得 4、60 天得 8），同一张图在 7 天与 30 天之间切换时刻度位置毫无延续性。
 * 固定步长下 7 天是 7 个、30 天也是 7 个，两档读起来是同一张图。
 */
function labelledColumns(count: number): ReadonlySet<number> {
  if (count <= AXIS_LABELS) {
    return new Set(Array.from({ length: count }, (_, index) => index))
  }

  const every = count > 45 ? 7 : 5
  const kept = new Set<number>()

  for (let index = 0; index < count; index += 1) {
    if (index === 0 || index === count - 1 || index % every === 0) {
      kept.add(index)
    }
  }

  return kept
}

/**
 * 那一天谁花了多少，只留真的花了的。
 *
 * 导出给测试：它同时是「这一天有没有数据」的判据（空数组即没有），而竖虚线画不画
 * 就取这个判据 —— 两条规则同一个来源，不会一处说有一天说没有。
 */
export function spendOf(series: readonly ModelSeries[], index: number) {
  return series
    .map((line, at) => ({
      ink: at % SERIES_INKS,
      label: line.label,
      tokens: line.days[index]?.count ?? 0,
    }))
    .filter((row) => row.tokens > 0)
}

export interface ModelTrendProps {
  readonly series: readonly ModelSeries[]
}

export function ModelTrend({ series }: ModelTrendProps) {
  const [hovered, setHovered] = useState<number | null>(null)
  const busiest = busiestOf(series.flatMap((line) => line.days))
  const days = series[0]?.days ?? []
  const marked = labelledColumns(days.length)

  /* 指针落在第几列。一列一格，判据只有位置，不依赖任何气泡的开关。 */
  const track = (event: MouseEvent<SVGSVGElement>) => {
    if (days.length === 0) {
      return
    }

    const box = event.currentTarget.getBoundingClientRect()
    const share = (event.clientX - box.left) / box.width
    /* 扣掉两端留白后，剩下的宽度上等分着 n 个点（首末贴边），按最近的取。 */
    const within = (share - INSET_SHARE) / (1 - INSET_SHARE * 2)
    const index = Math.round(within * (days.length - 1))

    setHovered(Math.min(days.length - 1, Math.max(0, index)))
  }

  const spend = hovered === null ? [] : spendOf(series, hovered)
  const anchor = hovered === null ? 0 : (xOf(hovered, days.length) / WIDTH) * 100

  return (
    <div className="settings-trend">
      <ul className="settings-trend__legend">
        {series.map((line, index) => (
          <li className="settings-trend__model" key={line.model}>
            <span
              aria-hidden="true"
              className="settings-trend__swatch"
              data-series={index % SERIES_INKS}
            />
            <span className="settings-trend__name">{line.label}</span>
          </li>
        ))}
      </ul>

      <div className="settings-trend__frame">
        <svg
          aria-label="每日 Token 趋势图"
          className="settings-trend__plot"
          onMouseLeave={() => setHovered(null)}
          onMouseMove={track}
          preserveAspectRatio="none"
          role="img"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        >
          {/*
           * 网格与折线用同一个纵向映射（yOf）：各算一套的话最上面那条会落在绘图区
           * 之外，屏幕上就是一条横虚线浮在线的上方。
           */}
          {GRID.map((rung) => {
            const y = HEIGHT - PAD_Y - (rung / 4) * (HEIGHT - PAD_Y * 2)

            return (
              <line className="settings-trend__grid" key={rung} x1="0" x2={WIDTH} y1={y} y2={y} />
            )
          })}

          {series.map((line, index) => (
            <path
              className="settings-trend__line"
              d={monotonePath(spotsOf(line, busiest))}
              data-series={index % SERIES_INKS}
              key={line.model}
            />
          ))}
        </svg>

        {/*
         * 悬浮那三样单独占一层：SVG 是后画的兄弟节点，不抬一层会把气泡压在折线底下。
         *
         * 竖虚线只在**这一天真的花过 token** 时才画：它是一条读数辅助线，指到一段
         * 空账上什么也读不出来，反而像在说那天有数据。圆点照画 —— 它们标的是折线
         * 此刻的位置，与那天有没有账无关。
         */}
        {hovered === null ? null : (
          <div className="settings-trend__overlay">
            {spend.length === 0 ? null : (
              <span className="settings-trend__guide" style={{ left: `${anchor}%` }} />
            )}

            {series.map((line, index) => (
              <span
                className="settings-trend__point"
                data-series={index % SERIES_INKS}
                key={line.model}
                style={{
                  left: `${anchor}%`,
                  top: `${(yOf(line.days[hovered]?.count ?? 0, busiest) / HEIGHT) * 100}%`,
                }}
              />
            ))}

            {spend.length === 0 ? null : (
              /*
               * 位置交给 CSS 的 clamp：气泡以锚点为中心画，靠边那一列会有一半伸到
               * 卡外被切掉，而这里算不出气泡自己有多宽。内联 left 会盖过那条规则，
               * 所以只把锚点交下去。
               */
              <div
                className="settings-trend__hint"
                style={{ '--settings-trend-anchor': `${anchor}%` } as CSSProperties}
              >
                {spend.map((row) => (
                  <p className="settings-trend__hint-row" key={row.label}>
                    <span
                      aria-hidden="true"
                      className="settings-trend__dot"
                      data-series={row.ink}
                    />
                    <span className="settings-trend__name">{row.label}</span>
                    <span className="settings-trend__hint-total">
                      {formatTokens(row.tokens)} token
                    </span>
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/*
       * 每个日期按折线上那一点的横坐标落位（同一个 xOf），不是等宽格子里居中：
       * 格心与数据点差半格，而半格随天数变，7 天与 30 天就会看着不像同一张图。
       */}
      <p className="settings-trend__axis">
        {days.map((day, index) =>
          marked.has(index) ? (
            <span key={day.date} style={{ left: `${(xOf(index, days.length) / WIDTH) * 100}%` }}>
              {AXIS_DATE.format(dateOf(day.date))}
            </span>
          ) : null,
        )}
      </p>
    </div>
  )
}
