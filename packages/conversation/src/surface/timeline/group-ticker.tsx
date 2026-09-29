import './group-ticker.css'
import './shimmer.css'

import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { memo, useEffect, useRef, useState } from 'react'
import { cx } from '../primitives/class-names'

/** 曲线与抽屉那一条同一条（primitives/disclosure.css）：0.2, 0, 0, 1。 */
const EASE: [number, number, number, number] = [0.2, 0, 0, 1]

/** 时长各自定：进场比退场短，退场里透明度最先收尾。 */
const ARRIVE = { duration: 0.18, ease: EASE }
const LEAVE = { duration: 0.22, ease: EASE, opacity: { duration: 0.12 } }

/** 宽度跟着字长变的那一下，与退场同时收尾。 */
const MORPH = { duration: 0.22, ease: EASE }

/* 有人要求少动效时：换字照旧发生，只是不占时间。 */
const AT_ONCE = { duration: 0 }

/**
 * 漂移距离。6px 刻意小：大了眼睛会去追位移而不读句子。纯模糊读成「同一句变清楚」，
 * 加位移才读出「换了一句，队列往前走了一格」。
 */
const DRIFT_PX = 6

/**
 * 一句话至少停留这么久。
 *
 * 400 > 220（一次切换的总时长），所以任何一次切换都不会被下一次打断。
 */
const HOLD_MS = 400

/**
 * 一个变化不许快过 holdMs 的值，解决「事实变得比眼睛快」：如实跟着换字，每次切换
 * 都会在动画播完前被下一次打断。
 *
 * 压着的期间不排队，到点交出那一刻的最新值，跳过的不补播 —— 补播是过去的历史，
 * 这一格说的是「现在」。第一次变化不压：changedAt 从负无穷起步，等待时间算出来
 * 是 0。
 */
function useHeldValue<T>(value: T, holdMs: number): T {
  const [shown, setShown] = useState(value)
  const changedAt = useRef(Number.NEGATIVE_INFINITY)

  useEffect(() => {
    if (Object.is(value, shown)) {
      return
    }

    /* 依赖里带着 shown：交出去之后这个 effect 会再跑一次，那一次两边相等，上面就退出了。 */
    const wait = Math.max(0, holdMs - (performance.now() - changedAt.current))

    const timer = setTimeout(() => {
      changedAt.current = performance.now()
      setShown(value)
    }, wait)

    /* value 在压着的期间又变了：这条清理会把上一个定时器撤掉，新的 effect 用同一个
       changedAt 重新算剩余时间。被跳过的那个值就此消失，这正是「不排队」。 */
    return () => {
      clearTimeout(timer)
    }
  }, [holdMs, shown, value])

  return shown
}

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
