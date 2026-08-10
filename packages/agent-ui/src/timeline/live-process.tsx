import './live-process.css'

import type { FeedRow } from '@poietica/agent'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { memo, type ReactNode } from 'react'

/** 曲线与抽屉那一条同一条（primitives/disclosure.css 里的 0.2, 0, 0, 1）。 */
const EASE: [number, number, number, number] = [0.2, 0, 0, 1]

const ARRIVE = { duration: 0.18, ease: EASE }

/*
 * 退场里 opacity 先走完，空间随后合上。
 *
 * 两段不同的时长换来的是「内容没了，位置随后让开」，而不是「一个盒子被卷起来」——
 * 后者读起来像收纳，而这一段工作不是被收纳，它是已经交给封条了。
 */
const LEAVE = { duration: 0.22, ease: EASE, opacity: { duration: 0.12 } }

/* 有人要求少动效时：退场照旧发生，只是不占时间。 */
const AT_ONCE = { duration: 0 }

/**
 * 这一段还没有结论的工作。
 *
 * 它坐在转录尾部，也就是虚拟器 paddingEnd 预留出来的那块空间里，因此仍然跟着一起
 * 滚，而它的内容不在虚拟器的条目表内 —— 换掉一帧不改变任何一行的身份，也不作废任何
 * 一行的实测高度。这是它存在的全部理由：过程若走 rows，一轮之内就必然有一次中段
 * 删除，而那一次删除就是屏幕上内容整段消失又出现。
 *
 * 范围由 turn-fold.ts 给出，不在这里判：只有「最后一段回复之后」的过程帧会进来。所以
 * 这里没有上限、没有内嵌滚动、也没有自动滚底 —— 模型说完一句话，之前那段工作已经归
 * 封条了，它不该还留在「现在正在做」里。
 *
 * 行怎么画同样不在这里判：renderRow 是转录用的那一个，两条通道因此长同一个样子，
 * 一帧从这里被封条收走时不会换外观。
 *
 * 进场与退场都归 motion —— 一处动画只有一套驱动。退场是这里非要一个库的那件事：
 * React 的卸载是同步的，节点一离开树就没有可以补间的对象，纯 CSS 做不到，而
 * AnimatePresence 的职责恰好只是「让离开的那一帧多留一会儿」。让开的那段空间不必
 * 另算：这块区域的实测高度本来就是虚拟器的 paddingEnd，高度补到 0 的每一帧都如实
 * 走完那条既有的回灌，末端跟着一起收 —— 回答落到底部的那段路就是它。
 *
 * prefers-reduced-motion 交给 useReducedMotion。motion 默认不替人做这个决定（要么
 * 这个 hook、要么全局 MotionConfig），所以这里显式读一次；命中就把时长压成 0，退场
 * 仍然发生，只是不占时间。
 */
export interface LiveProcessProps {
  readonly rows: readonly FeedRow[]
  readonly renderRow: (row: FeedRow) => ReactNode
}

export const LiveProcess = memo(function LiveProcess({ renderRow, rows }: LiveProcessProps) {
  const still = useReducedMotion() === true

  /* 空着时也不摘掉 AnimatePresence：正在退场的那几帧只能留在还挂着的子树里。它此刻
     不产生任何节点，所以尾部盒子照旧是 :empty。 */
  return (
    <AnimatePresence>
      {rows.map((row) => (
        <motion.div
          animate={{ opacity: 1 }}
          className="live-process__slot"
          exit={{ height: 0, opacity: 0, transition: still ? AT_ONCE : LEAVE }}
          initial={{ opacity: 0 }}
          key={row.item.id}
          transition={still ? AT_ONCE : ARRIVE}
        >
          <div className="live-process__frame">{renderRow(row)}</div>
        </motion.div>
      ))}
    </AnimatePresence>
  )
})
