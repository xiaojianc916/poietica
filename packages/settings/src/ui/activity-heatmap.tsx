import { Tooltip, TooltipContent, TooltipTrigger } from '@poietica/design-system'
import { Fragment } from 'react'
import {
  type ActivityDay,
  busiestOf,
  dateOf,
  formatTokens,
  HEAT_LEVELS,
  levelOf,
  weekdayOf,
} from './usage-activity'

/*
 * 热力图：一格一天，一列一周，周一在最上面。形制取自 GitHub 贡献图 / kibo-ui
 * Contribution Graph：进来的是已铺好的日历，出去的是格子，分档交给 data 属性由
 * CSS 决定。依赖一个不装（kibo 按 shadcn registry 分发，装它拷进一整套外来排版）。
 * 提示走设计系统 Tooltip，不用原生 title：同页不能有两种气泡。
 */

const CELL_DATE = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' })

/** 没有账可记的日子不弹提示：写「0 token」是在替一本空账下结论。 */
function tooltipOf(day: ActivityDay): string | undefined {
  if (day.count <= 0) {
    return undefined
  }

  return `${CELL_DATE.format(dateOf(day.date))}：${formatTokens(day.count)} token`
}

export interface ActivityHeatmapProps {
  readonly days: readonly ActivityDay[]
}

export function ActivityHeatmap({ days }: ActivityHeatmapProps) {
  const busiest = busiestOf(days)

  return (
    <div className="settings-heatmap">
      <div className="settings-heatmap__grid">
        {days.map((day, index) => {
          const hint = tooltipOf(day)
          const cell = (
            <span
              className="settings-heatmap__cell"
              data-level={levelOf(day.count, busiest)}
              style={index === 0 ? { gridRowStart: weekdayOf(day.date) + 1 } : undefined}
            />
          )

          /*
           * 没账的日子不装空气泡：Trigger 配没有 Popup 的 Root 不在官方用法里。
           */
          return hint === undefined ? (
            <Fragment key={day.date}>{cell}</Fragment>
          ) : (
            <Tooltip key={day.date}>
              <TooltipTrigger render={cell} />
              <TooltipContent side="top">{hint}</TooltipContent>
            </Tooltip>
          )
        })}
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
