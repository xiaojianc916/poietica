import './thread-disclosure.css'

import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'
import { ENTER_EASE, ENTER_SECONDS, EXIT_EASE, EXIT_SECONDS } from '../primitives/motion'

/*
 * 一段会收起的侧栏内容。
 *
 * 侧栏是高频导航，不是展示区域：这里要的是快、无回弹、非对称，而不是好看。
 * 标杆客户端（Linear、Slack、Xcode 的大纲）在这个位置给的都是 120–200 毫秒的
 * 高度过渡，没有一个用弹簧回弹，也没有一个做逐行错开——错开属于首屏，不属于
 * 一天要点几十次的东西。
 *
 * 展开与收起不共用一条曲线。展开走减速：多出来的内容需要让人看清是什么。
 * 收起走加速、且更短：收起是一个已经做完的决定，不需要陪着看完。这一点是
 * 这类动画显得称手还是廉价的分水岭，而 CSS 的一条 transition 声明写不出来。
 *
 * 透明度与高度不同步。展开时它延后一点再走，先让位置定下来，再让字浮上来；
 * 收起时它先走完，先淡出再压高度——否则那一下看起来像把文字压扁了。
 *
 * 用 motion 而不是仓库里那套 grid 0fr→1fr（primitives/disclosure.css）：那套
 * 要求内容常驻 DOM，靠 inert 屏蔽；这一列可能挂着几百条会话，而且整段本来就
 * 有该消失的时候（没有固定项时 Pinned 不存在）。AnimatePresence 负责"先播完
 * 再卸载"这一段，纯 CSS 做不到。timeline 那套不动它，那边的行挂着虚拟器的
 * measureElement，换实现是另一件事。
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
