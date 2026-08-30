import {
  type ActivityDay,
  busiestOf,
  dateOf,
  HEAT_LEVELS,
  levelOf,
  weekdayOf,
} from './usage-activity'

/*
 * 热力图：一格一天，一列一周，周一在最上面。
 *
 * 形制取自 GitHub 的贡献图与 kibo-ui 的 Contribution Graph。后者对自己的定位写
 * 得很清楚 ——「只是可视化层，不管数据获取与状态」，分档交给 data 属性由 CSS
 * 决定。这两条正是这里照搬的：进来的是已经铺好的一段日历，出去的是格子。
 *
 * 依赖一个都不装。kibo 那个组件按 shadcn registry 的办法分发，装它等于把它自己
 * 的一套排版连同源码拷进来，而这一页的排版要跟设置界面走。
 *
 * 第一列不一定从周一开始，所以第一格直接落到它该在的那一行，其余由 grid 按列
 * 往下排。空格子不进 DOM：那是几个不表示任何一天的方块。
 */

const CELL_DATE = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' })
const CELL_COUNT = new Intl.NumberFormat('zh-CN')

/** 没有账可记的日子不弹提示：写「0 token」是在替一本空账下结论。 */
function tooltipOf(day: ActivityDay): string | undefined {
  if (day.count <= 0) {
    return undefined
  }

  return `${CELL_DATE.format(dateOf(day.date))}：${CELL_COUNT.format(day.count)} token`
}

export interface ActivityHeatmapProps {
  readonly days: readonly ActivityDay[]
}

export function ActivityHeatmap({ days }: ActivityHeatmapProps) {
  const busiest = busiestOf(days)

  return (
    <div className="settings-heatmap">
      <div className="settings-heatmap__grid">
        {days.map((day, index) => (
          <span
            className="settings-heatmap__cell"
            data-level={levelOf(day.count, busiest)}
            key={day.date}
            style={index === 0 ? { gridRowStart: weekdayOf(day.date) + 1 } : undefined}
            title={tooltipOf(day)}
          />
        ))}
      </div>

      <p className="settings-heatmap__legend">
        <span>较少</span>

        {HEAT_LEVELS.map((level) => (
          <span className="settings-heatmap__cell" data-level={level} key={level} />
        ))}

        <span>较多</span>
      </p>
    </div>
  )
}
