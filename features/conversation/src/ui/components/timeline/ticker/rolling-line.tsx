import './rolling-line.css'
import './shimmer.css'

import { systemClock } from '@poietica/foundation'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cx } from '../../primitives/class-names'
import { StaticLine, TickerLine } from './marquee-track'
import { createRollScheduler, FAST_ROLL_MS, type LineSnapshot, ROLL_MS } from './roll-scheduler'

/**
 * 组头那一格「正在做什么」：思考句在写时像显示屏往左滚（TickerLine，最新的字永远完整、左边缘直接裁），
 * 工具行与落定态不动、放不下时末尾省略号（StaticLine）；换句才上下刷一次。
 * 容器只做三件事：把句子喂给调度器、在提升时换 key、按状态选哪一种格子。
 */

const ROLL_DISTANCE = '0.6em'
const ROLL_EASE: [number, number, number, number] = [0.4, 0, 0.2, 1]
const AT_ONCE = { duration: 0 }

export interface RollingLineProps {
  /** 这一格的身份：它变了才播一次上下刷。 */
  readonly contentKey: string
  /** 还有成员在动：思考句滚动；否则这是落定的摘要，从头显示。 */
  readonly following: boolean
  /** thought：思考句；tool：工具调用句。 */
  readonly variant?: 'thought' | 'tool'
  /** 上一句（只有思考句有）：换句时用来把旧句补完。 */
  readonly previous?: LineSnapshot | null
  /** 戴扫光：在飞的工具调用与「正在思考」占位。戴扫光的格子一律不滚。 */
  readonly shimmer?: boolean
  readonly text: string
}

export const RollingLine = memo(function RollingLine({
  contentKey,
  following,
  previous = null,
  shimmer = false,
  text,
  variant = 'tool',
}: RollingLineProps) {
  const reduced = useReducedMotion() === true
  const [rolls] = useState(() => createRollScheduler({ key: contentKey, text }, systemClock, reduced))
  const [rolled, setRolled] = useState({ key: contentKey, fast: false })
  /* 首次挂载时就在的那一句不算「新句」：直接摆好，不从第一个字重写一遍。 */
  const mountedKey = useRef(contentKey)
  /* 「下一句在等」必须进状态：渲染期读 rolls.waiting() 会晚一批 token 才生效，慢模型下旧句的收尾就整段错过。 */
  const [waiting, setWaiting] = useState(false)

  useEffect(() => {
    const subscription = rolls.onPromote((promotion) => {
      setRolled({ key: promotion.snapshot.key, fast: promotion.fast })
    })

    return () => {
      subscription.dispose()
      rolls.dispose()
    }
  }, [rolls])

  useLayoutEffect(() => {
    rolls.setImmediate(reduced)
  }, [rolls, reduced])

  /* 每次渲染都喂一次：同 key 原地生长，异 key 排队换句；换句要重渲染，所以放布局副作用里。 */
  useLayoutEffect(() => {
    rolls.offer({ key: contentKey, text }, previous)
    /* 同值时 React 跳过；变了就在绘制前补一轮渲染，旧句这一帧开始收尾。 */
    setWaiting(rolls.waiting())
  })

  /* 显示哪一句：调度器说的就是这次 prop 这一句时直接用 prop 的文字（原地生长不等一轮渲染）。 */
  const shownLine = rolls.shown()
  const line = shownLine.key === contentKey ? { key: contentKey, text } : shownLine
  const ticking = following && variant === 'thought' && !shimmer

  return (
    <span className="rolling-line" data-following={following ? '' : undefined} data-variant={variant}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          animate={{ opacity: 1, y: 0 }}
          className={cx('rolling-line__slot', shimmer && 'timeline-shimmer')}
          data-line-key={line.key}
          exit={{ opacity: 0, y: `-${ROLL_DISTANCE}` }}
          initial={{ opacity: 0, y: ROLL_DISTANCE }}
          key={line.key}
          transition={reduced ? AT_ONCE : { duration: (rolled.fast ? FAST_ROLL_MS : ROLL_MS) / 1000, ease: ROLL_EASE }}
        >
          {ticking ? (
            <TickerLine
              finishing={waiting}
              fresh={line.key !== mountedKey.current}
              ink
              reduced={reduced}
              text={line.text}
            />
          ) : (
            <StaticLine text={line.text} />
          )}
        </motion.span>
      </AnimatePresence>
    </span>
  )
})
