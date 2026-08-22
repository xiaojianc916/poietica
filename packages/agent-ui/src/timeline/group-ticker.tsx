import './group-ticker.css'
import './shimmer.css'

import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { memo } from 'react'
import { cx } from '../primitives/class-names'
import { useHeldValue } from '../primitives/use-held-value'

/** 曲线与 live-process、抽屉那一条同一条（0.2, 0, 0, 1）。 */
const EASE: [number, number, number, number] = [0.2, 0, 0, 1]

/** 时长也照 live-process 那两个数，不另发明一套。 */
const ARRIVE = { duration: 0.18, ease: EASE }
const LEAVE = { duration: 0.22, ease: EASE, opacity: { duration: 0.12 } }

/** 宽度跟着字长变的那一下，与退场同时收尾。 */
const MORPH = { duration: 0.22, ease: EASE }

/* 有人要求少动效时：换字照旧发生，只是不占时间。 */
const AT_ONCE = { duration: 0 }

/**
 * 漂移距离。
 *
 * 6px 是刻意的小：再大一点眼睛就会去追那个位移，而不是去读那句话。它存在的唯一理由是
 * 给这次变化一个方向 —— 纯模糊读起来像「同一句话变清楚了」，加上这 6px 才读得出「换了
 * 一句，队列往前走了一格」。
 */
const DRIFT_PX = 6

/**
 * 一句话至少停留这么久。
 *
 * 400 > 220（一次切换的总时长），所以任何一次切换都不会被下一次打断。
 */
const HOLD_MS = 400

export interface GroupTickerProps {
  /** 组里还有人在飞。它只管那道光，不管印哪句话 —— 印哪句由 text 说了算。 */
  readonly isRunning: boolean
  readonly text: string
}

/** 汇总状态只用 opacity 与 transform，避免文字 filter 常驻合成层。 */
export const GroupTicker = memo(function GroupTicker({ isRunning, text }: GroupTickerProps) {
  const still = useReducedMotion() === true
  const shown = useHeldValue(text, HOLD_MS)

  return (
    <motion.span className="group-ticker" layout transition={still ? AT_ONCE : MORPH}>
      {/* initial={false}：这一组刚出现的那一帧不播进场。组头本身正在挂上去，让它内部
          再演一遍是同一个动作做两次。 */}
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          animate={{ opacity: 1, x: 0 }}
          className={cx('group-ticker__line', isRunning && 'timeline-shimmer')}
          exit={{
            opacity: 0,
            transition: still ? AT_ONCE : LEAVE,
            x: -DRIFT_PX,
          }}
          initial={{ opacity: 0, x: DRIFT_PX }}
          key={shown}
          layout="position"
          transition={still ? AT_ONCE : ARRIVE}
        >
          {shown}
        </motion.span>
      </AnimatePresence>
    </motion.span>
  )
})
