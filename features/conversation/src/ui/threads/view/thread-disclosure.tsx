import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'
import { ENTER_EASE, ENTER_SECONDS, EXIT_EASE, EXIT_SECONDS } from '../../shared/primitives/motion'

/* 不用 grid 0fr→1fr（primitives/disclosure.css）：那套要求内容常驻 DOM，而这一列可能挂几百条会话；展开与收起各要一条曲线，一条 transition 写不出来。 */

export interface ThreadDisclosureProps {
  readonly children: ReactNode
  readonly isOpen: boolean
}

export function ThreadDisclosure({ children, isOpen }: ThreadDisclosureProps) {
  /* 只有明确说了「要减少」才归零：useReducedMotion 的返回值是 boolean | null。 */
  const isReduced = useReducedMotion() === true
  const enter = isReduced ? 0 : ENTER_SECONDS
  const exit = isReduced ? 0 : EXIT_SECONDS

  return (
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
          /* 退场时内容还在，键盘与读屏不该够得着它。 */
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
