import './running-status.css'
import { memo } from 'react'
import { useSecond } from '../primitives/clock'
import { formatRunDuration } from '../semantics/duration'

/**
 * 对话最下面那一行「深度求索中，用时 N秒 ···」（DSH RunningStatus）。
 *
 * 只要这一轮还在跑就挂在转录末尾：有起始时刻就报时长（秒针走本地时钟，每秒自己重画这一格，
 * 不牵动整条时间线），没有就只报那半句。它**不在虚拟列表里** —— 它是常驻的最后一行，
 * 高度不参与行测量，也不会因为换字被当成内容长高。
 */

/** DSH 的时长下限：不足一秒也报 1 秒，屏幕上不出现「0秒」。 */
const MIN_RUN_MS = 1_000

/*
 * 结尾那三个是 U+00B7 MIDDLE DOT，不是省略号：DSH 用它说「还在往外冒」，
 * 而省略号读起来是「这里被截断了」。
 */
const TAIL = ' ···'

/** 鲸鱼尾的静态描边路径，与 APNG 同一枚图形；动效不被支持时由它顶上。 */
const REST_PATH =
  'M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368C5.157 11.27 5.089 12.19 4.926 13.742'

/** 动的用 APNG 当 mask、静的用描边 SVG，二选一由 CSS 定（见 running-status.css）。 */
function WhaleTail() {
  return (
    <span aria-hidden="true" className="running-status__icon">
      <span className="running-status__whale-animated" />
      {/* 两层都是装饰：这一行说了什么由旁边那句话负责，图标不承担信息。 */}
      <svg aria-hidden="true" className="running-status__whale-still" fill="none" viewBox="0 0 16 16">
        <path d={REST_PATH} stroke="currentColor" strokeWidth={1} />
      </svg>
    </span>
  )
}

export interface RunningStatusProps {
  /** 还在跑的这一轮的起始时刻；缺席时只报「深度求索中」。 */
  readonly startedAt: number | undefined
  /** 上方已经有产出（不止是人说的话）：画那道分隔线。 */
  readonly divided: boolean
}

export const RunningStatus = memo(function RunningStatus({ divided, startedAt }: RunningStatusProps) {
  const now = useSecond(startedAt !== undefined)
  const elapsed = startedAt === undefined ? undefined : Math.max(MIN_RUN_MS, now - startedAt)
  const label = elapsed === undefined ? '深度求索中' : `深度求索中，用时 ${formatRunDuration(elapsed)}${TAIL}`

  return (
    <div className="running-status" data-chat-running="">
      {/* 只播报那半句固定的话：带秒数的可见文案每秒都在变，挂 aria-live 会让读屏用户永远停不下来。 */}
      <span aria-atomic="true" aria-live="polite" className="running-status__announce" role="status">
        深度求索中
      </span>

      {divided ? <span aria-hidden="true" className="running-status__divider" /> : null}

      <span className="running-status__content">
        <WhaleTail />
        <span className="running-status__text timeline-shimmer">{label}</span>
      </span>
    </div>
  )
})
