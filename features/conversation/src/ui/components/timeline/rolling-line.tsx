import './rolling-line.css'
import './shimmer.css'

import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cx } from '../primitives/class-names'
import { MarqueeTrack } from './marquee-track'
import { createRollScheduler, FAST_ROLL_MS, type LineSnapshot, ROLL_MS } from './roll-scheduler'

/**
 * 组头那一格「正在做什么」：一句话，写到一半自己往前推。
 *
 * 三条规矩，少一条都读不出「正在写」：
 *
 *   1. **同一句继续写是原地生长**。模型一个 token 一个 token 地吐字，屏幕上就该一个 token
 *      一个 token 地长。横向那一趟由 MarqueeTrack 逐帧负责，不进 React。
 *   2. **换句才上下刷一次**：新句从下方升起、旧句往上走掉（0.6em / 260ms / (0.4, 0, 0.2, 1)）。
 *      什么时候算「换句」由 RollScheduler 定 —— 它要等旧句说完（划到位再停一下），又不能
 *      无限等（新句最多 1200ms）。积压时快速刷（140ms），过期的不补播。
 *   3. **不动的两种**：落定之后从头显示、末尾省略号（那时这句是结论，从头读起才对）；
 *      工具行不横移，超宽时右对齐显示末尾、左边淡出。
 *
 * 遮罩与几何归 rolling-line.css，横向追随归 marquee-track / use-marquee，墨迹归 ink-tail。
 * 容器只做三件事：把句子喂给调度器、在提升时换 key、按状态决定 mode。
 */

/** 上下刷那一层位移；0.8em 在一行高里显得重。 */
const ROLL_DISTANCE = '0.6em'

/** 退场的轻微模糊：读成「刷过去」，而不是「跳走」。 */
const ROLL_BLUR_PX = 1.5

/** 曲线与 zcode 那条滚动同一条（它的 SUMMARY_ROLL_TRANSITION）。 */
const ROLL_EASE: [number, number, number, number] = [0.4, 0, 0.2, 1]

/** 有人要求少动效时：不划不刷，直接显示当前句。 */
const AT_ONCE = { duration: 0 }

export interface RollingLineProps {
  /** 这一格的身份：它变了才播一次上下刷（思考句的起始偏移、工具调用的 id）。 */
  readonly contentKey: string
  /** 还在写：跟着末尾走，被省略号吃掉最新几个字就白说了。 */
  readonly following: boolean
  /** thought：思考句（划动 + 墨迹）；tool：工具调用句（超宽时右对齐显示末尾）。 */
  readonly variant?: 'thought' | 'tool'
  /** 上一句（只有思考句有）：同一批 token 里旧句收尾时用来把旧句补完。 */
  readonly previous?: LineSnapshot | null
  /** 戴那道扫光。它只归在飞的工具调用与「正在思考」的占位。 */
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
  /*
   * 这一格全部的可变状态都在两处：调度器里（哪一句、等多久）和这里的 `fast`。
   * 当前那一句本身不另存一份 —— 调度器就是它的主人，渲染时现读（见下面 `line` 那一段）。
   */
  const [fast, setFast] = useState(false)
  /*
   * 调度器放行过的那一句。
   *
   * 只存「哪一句」（key），文字一律现读 —— 见下面 `line` 那一段。换句是这一格唯一的结构性
   * 变化，所以这一份状态也是重渲染的唯一来源。
   */
  const [rolledKey, setRolledKey] = useState(contentKey)
  const [rolls, setRolls] = useState(() => createRollScheduler({ key: contentKey, text }, undefined, reduced))
  const still = useRef(reduced)

  /* 少动效的开关中途变了（系统设置、DevTools 里改）：换一座调度器，规则那一套跟着换。 */
  if (still.current !== reduced) {
    still.current = reduced
    setRolls(createRollScheduler(rolls.shown(), undefined, reduced))
  }

  useEffect(() => {
    const subscription = rolls.onPromote((promotion) => {
      /* 换句：重渲染一次，`line` 那一段于是读到新的这一句。 */
      setFast(promotion.fast)
      setRolledKey(promotion.snapshot.key)
    })

    return () => {
      subscription.dispose()
      /* 删除路径：换掉或卸载时清计时器与监听者，不留下自己在跑的定时器。 */
      rolls.dispose()
    }
  }, [rolls])

  /*
   * 每次渲染都喂一次。同 key 是原地生长（调度器只更新文字、并且把「已到位」作废），异 key
   * 才排队换句。放在布局副作用里：换句要重渲染，那是渲染期不该做的事。
   */
  useLayoutEffect(() => {
    rolls.offer({ key: contentKey, text }, previous)
  })

  /*
   * 显示哪一句。
   *
   * 主人是调度器，这里现读它的 `shown()`。两件事要分开：
   *
   *   • **原地生长**不能等调度器提升 —— 那要走一遍重渲染，每来一个 token 就多等一帧。
   *     所以只要 `shown()` 说的还是这次 prop 这一句（key 对得上），就直接用 prop 上的 text。
   *   • **换句**时 `shown()` 已经换了，但 `rolledKey` 还没跟上（它由提升回调设置）；
   *     这一刻渲染的仍是 `shown()` —— 也就是刚提升的那一句，不会出现半旧的中间态。
   */
  const shownLine = rolls.shown()
  const line = shownLine.key === contentKey ? { key: contentKey, text } : { key: rolledKey, text: shownLine.text }
  const mode = !following ? 'start' : variant === 'thought' ? 'glide' : 'tail'

  return (
    <span className="rolling-line" data-following={following ? '' : undefined} data-variant={variant}>
      {/* initial={false}：这一格刚挂上去的那一帧不播进场 —— 组头自己正在出现，
          让它内部再演一遍是同一个动作做两次。 */}
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          animate={{ filter: 'blur(0px)', opacity: 1, y: 0 }}
          className={cx('rolling-line__slot', shimmer && 'timeline-shimmer')}
          exit={{ filter: `blur(${String(ROLL_BLUR_PX)}px)`, opacity: 0, y: `-${ROLL_DISTANCE}` }}
          initial={{ filter: 'blur(0px)', opacity: 0, y: ROLL_DISTANCE }}
          key={line.key}
          transition={reduced ? AT_ONCE : { duration: (fast ? FAST_ROLL_MS : ROLL_MS) / 1000, ease: ROLL_EASE }}
        >
          <MarqueeTrack
            ink={variant === 'thought' && !shimmer}
            mode={mode}
            /* 报告「这一句已经划到位」：调度器靠它算「旧句说完了没有」。 */
            onSettled={() => {
              rolls.settled(line.key)
            }}
            reduced={reduced}
            text={line.text}
          />
        </motion.span>
      </AnimatePresence>
    </span>
  )
})
