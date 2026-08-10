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
 * 散焦的程度。
 *
 * 这一层的隐喻是对焦：旧的那句散掉，新的那句收拢。它比纯淡入淡出多出来的东西，正是
 * 「有个东西在想」这件事。
 */
const HAZE = 'blur(3px)'
const CLEAR = 'blur(0px)'

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

/**
 * 汇总行那一格字，换字的时候模糊着换。
 *
 * 为什么不做纵向滚动：那是航班牌和数字的语汇，内容同构、等宽、有序。这里换的是一句一句
 * 长短不一的人话，整体上下平移会让眼睛去追位移；而且那两百毫秒里两行字处在不同高度上，
 * 视觉上就是两行，哪怕盒子只有一行高。留在原地改变清晰度，才是这类状态字的做法。
 *
 * 那道光照旧。它挂在印字的那一层上而不是整格上 —— 渐变的几何以戴它的盒子为准，量的该是
 * 这句话的宽度；理由 shimmer.css 里写着。换字期间两条都戴着，各自的透明度会替它们把重叠
 * 那一段处理干净。
 *
 * 宽度交给 motion 的 layout：字一长一短，整格跟着变宽变窄，右边那枚箭头于是被字带着平滑
 * 地滑过去，而不是跳一下。里面那一层挂 layout="position" 是必须的 —— layout 用的是 FLIP，
 * 尺寸变化靠 scaleX 呈现，不给里层反向修正的话，字会被横向拉伸，那道光的渐变也会跟着抻。
 *
 * 已知的一处将就：进场落位之后 filter 停在 blur(0px) 而不是彻底摘掉，于是这一层始终是
 * 被单独合成的，字的抗锯齿可能比周围略淡一档。摘掉它需要在动画结束时改内联样式，而那会
 * 让退场动画的起点变成 none —— 换一个更难验的风险。真觉得字虚了，旋钮在这里。
 */
export const GroupTicker = memo(function GroupTicker({ isRunning, text }: GroupTickerProps) {
  const still = useReducedMotion() === true
  const shown = useHeldValue(text, HOLD_MS)

  return (
    <motion.span className="group-ticker" layout transition={still ? AT_ONCE : MORPH}>
      {/* initial={false}：这一组刚出现的那一帧不播进场。组头本身正在挂上去，让它内部
          再演一遍是同一个动作做两次。 */}
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          animate={{ filter: CLEAR, opacity: 1, x: 0 }}
          className={cx('group-ticker__line', isRunning && 'timeline-shimmer')}
          exit={{
            filter: HAZE,
            opacity: 0,
            transition: still ? AT_ONCE : LEAVE,
            x: -DRIFT_PX,
          }}
          initial={{ filter: HAZE, opacity: 0, x: DRIFT_PX }}
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
