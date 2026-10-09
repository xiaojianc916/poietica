import './thread-disclosure.css'

import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'
import { ENTER_EASE, ENTER_SECONDS, EXIT_EASE, EXIT_SECONDS } from '../primitives/motion'

/*
 * 一段会收起的侧栏内容。侧栏是高频导航：要快、无回弹、非对称。标杆客户端
 * （Linear、Slack、Xcode 的大纲）在这个位置给的都是 120–200 毫秒的高度过渡，
 * 没有弹簧回弹，也没有逐行错开。
 *
 * 展开与收起不共用一条曲线：展开走减速，收起走加速且更短，CSS 的一条 transition
 * 声明写不出来。透明度与高度错拍：展开时延后一点走，先定位置再浮字；收起时先
 * 走完，先淡出再压高度，否则像把文字压扁。
 *
 * 用 motion 而不是 grid 0fr→1fr（primitives/disclosure.css）：那套要求内容常驻 DOM，
 * 而这一列可能挂几百条会话；AnimatePresence 负责「先播完再卸载」，纯 CSS 做不到。
 * timeline 那套不动它，那边的行挂着虚拟器的 measureElement。
 */

export interface ThreadDisclosureProps {
  readonly children: ReactNode
  readonly isOpen: boolean
}

export function ThreadDisclosure({ children, isOpen }: ThreadDisclosureProps) {
  /*
   * 关掉动画是系统级偏好，不是这一处的开关。返回值是 boolean | null，
   * 只有明确说了"要减少"才归零。
   */
  const isReduced = useReducedMotion() === true
  const enter = isReduced ? 0 : ENTER_SECONDS
  const exit = isReduced ? 0 : EXIT_SECONDS

  return (
    /* initial={false}：开窗那一帧不该播一遍，那不是一次交互。 */
    <AnimatePresence initial={false}>
      {isOpen ? (
        <motion.div
          animate={{
            height: 'auto',
            opacity: 1,
            transition: {
              height: { duration: enter, ease: ENTER_EASE },
              opacity: { delay: enter * 0.25, duration: enter * 0.6, ease: 'linear' },
            },
          }}
          className="thread-disclosure"
          exit={{
            height: 0,
            opacity: 0,
            transition: {
              height: { duration: exit, ease: EXIT_EASE },
              opacity: { duration: exit * 0.7, ease: 'linear' },
            },
          }}
          /* 退场那几十毫秒里内容还在，键盘与读屏不该够得着它。 */
          inert={!isOpen}
          initial={{ height: 0, opacity: 0 }}
          key="thread-disclosure"
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
