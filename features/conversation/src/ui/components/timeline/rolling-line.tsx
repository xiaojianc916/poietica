import './rolling-line.css'
import './shimmer.css'

import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cx } from '../primitives/class-names'

/**
 * 组头那一格「正在做什么」：一句话，写到一半自己往前推。
 *
 * 做法逐条复刻 zcode-ref：`packages/ui/src/ToolCallBlocks/QueuedSummaryContent.tsx` 的滚动
 * 队列，加上 `packages/ui/src/components/ai-elements/reasoning.tsx` 的取行与超宽处理。
 * 要紧的只有三条，少一条都读不出「正在写」：
 *
 *   1. **同一格继续写是原地刷新**。模型一个 token 一个 token 地吐字，屏幕上就该一个 token
 *      一个 token 地长；滚动是「换了一格」的记号，不是「又长了一个字」的记号。先把每
 *      一个变化都当成换格来播，眼睛追的就是动画，不是字。
 *   2. **换格才滚一次**：新句从下方升起、旧句往上走掉（0.8em / 300ms / (0.4, 0, 0.2, 1)），
 *      随后停 500ms。排队上限两格；定时器迟到超过 250ms 就只播最后一格 —— 中间那几格是
 *      过去的事，补播会让人在卡顿恢复后看一段过期的排队。
 *   3. **在写的那一格不收省略号**：内容保持自己的宽度，盒子滚到末尾，两端各化开一段。
 *      单行盒子用省略号收尾时，被吃掉的正是最新那几个字 —— 那正是人在等的东西。
 *
 * 落定之后（following 撤掉）回到省略号：那时这句话是结论，从头读起才对。
 */

interface LineSnapshot {
  readonly key: string
  readonly text: string
}

/** 300ms 走完，随后停 500ms —— 两者之和是一格的最短寿命。 */
const ROLL_MS = 300
const HOLD_MS = 500
const SLOT_MS = ROLL_MS + HOLD_MS

/** 主线程忙时定时器会迟到；迟到这么多且还有排队，就跳过中间那些。 */
const DRIFT_SKIP_MS = 250

/** 最多三格在场：正在播的、下一格、可插队的一格。 */
const MAX_PENDING = 2

/** 曲线与 zcode 那条滚动同一条（它的 SUMMARY_ROLL_TRANSITION）。 */
const ROLL: { readonly duration: number; readonly ease: [number, number, number, number] } = {
  duration: ROLL_MS / 1000,
  ease: [0.4, 0, 0.2, 1],
}

/** 有人要求少动效时：换字照旧，只是不排队、不占时间。 */
const AT_ONCE = { duration: 0 }

/** 超宽判据的容差：scrollWidth 可以是小数，clientWidth 是整数。 */
const OVERFLOW_SLACK_PX = 1

/** 单行盒子还藏没藏着字；藏着就滚到末尾，否则回到开头。 */
function syncLineEnd(node: HTMLSpanElement, following: boolean): boolean {
  const overflowing = node.scrollWidth > node.clientWidth + OVERFLOW_SLACK_PX

  node.scrollLeft = following ? node.scrollWidth : 0

  return overflowing
}

/**
 * 一格的宽度这笔账。
 *
 * 三条来路都要管，缺一条这一格就会停在错的状态上：滚（人在看的时候自己滚）、盒变形
 * （窗口变窄，同一句话就超宽了）、换格（新句更长）。前两条靠 ResizeObserver，第三条靠
 * revision —— 这盒子没有别的东西会通知它内容变宽了（zcode 也是按 streamingSummary.text
 * 重跑这一段的）。
 */
function useLineOverflow(
  following: boolean,
  revision: string,
): { readonly overflowing: boolean; readonly viewport: (node: HTMLSpanElement | null) => void } {
  const [node, setNode] = useState<HTMLSpanElement | null>(null)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    /* 内容变了就重量一次：这盒子没有别的东西会通知它「句子变宽了」。 */
    void revision

    if (node === null) {
      return undefined
    }

    const sync = (): void => {
      const next = syncLineEnd(node, following)

      setOverflowing((current) => (current === next ? current : next))
    }

    sync()
    node.addEventListener('scroll', sync, { passive: true })

    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(sync)
    resize?.observe(node)

    return () => {
      node.removeEventListener('scroll', sync)
      resize?.disconnect()
    }
  }, [following, node, revision])

  return { overflowing, viewport: setNode }
}

export interface RollingLineProps {
  /** 这一格的身份：它变了才播一次滚动（推理的行号、工具调用的 id）。 */
  readonly contentKey: string
  /** 还在写：不收省略号，滚到末尾，两端化开。 */
  readonly following: boolean
  /** 戴那道扫光。它只归在飞的工具调用，思考不走这盏灯。 */
  readonly shimmer?: boolean
  readonly text: string
}

/**
 * 一格字。
 *
 * 尺寸变化有三条来路，缺一条这一格就会停在错的状态上：滚（在看的时候自己滚）、盒变形
 * （窗口变窄会让同一句话变宽）、换格（新句更长）。前两条靠 ResizeObserver，第三条靠
 * 每次换字之后重算一次 —— 这盒子没有别的东西会通知它内容变宽了。
 */
export const RollingLine = memo(function RollingLine({
  contentKey,
  following,
  shimmer = false,
  text,
}: RollingLineProps) {
  const still = useReducedMotion() === true
  const [shown, setShown] = useState<LineSnapshot>(() => ({ key: contentKey, text }))
  const shownValue = useRef(shown)
  const pending = useRef<LineSnapshot[]>([])
  const slotTimer = useRef<number | null>(null)
  const rolling = useRef(false)

  useEffect(() => {
    shownValue.current = shown
  }, [shown])

  useEffect(() => {
    const stopSlot = (): void => {
      if (slotTimer.current !== null) {
        window.clearTimeout(slotTimer.current)
        slotTimer.current = null
      }
    }

    /*
     * 排队：同一个 key 只更新那一格 —— 它还没轮到播，值就该是最新的那份，不是最早那份
     * （zcode 对正在等待的文件摘要做的是同一件事）。槽位只有三个，第二条不许被覆盖，
     * 新来的只能替换第三格。
     */
    const enqueue = (snapshot: LineSnapshot): void => {
      const queued = pending.current
      const at = queued.findIndex((one) => one.key === snapshot.key)

      if (at >= 0) {
        const next = [...queued]
        next[at] = snapshot
        pending.current = next
        return
      }

      pending.current = queued.length === 0 ? [snapshot] : [queued[0] ?? snapshot, snapshot].slice(0, MAX_PENDING)
    }

    const promote = (snapshot: LineSnapshot): void => {
      shownValue.current = snapshot
      setShown(snapshot)
      rolling.current = true
      stopSlot()

      const dueAt = performance.now() + SLOT_MS

      slotTimer.current = window.setTimeout(() => {
        rolling.current = false
        slotTimer.current = null

        const late = performance.now() - dueAt > DRIFT_SKIP_MS
        const queued = late && pending.current.length > 1 ? pending.current.slice(-1) : pending.current
        const [next, ...rest] = queued

        pending.current = rest

        if (next !== undefined) {
          promote(next)
        }
      }, SLOT_MS)
    }

    const next: LineSnapshot = { key: contentKey, text }
    const settled = shownValue.current.key === next.key && shownValue.current.text === next.text

    /* 少动效：直接换字，队列与计时器全撤掉。 */
    if (still) {
      stopSlot()
      rolling.current = false
      pending.current = []

      if (!settled) {
        shownValue.current = next
        setShown(next)
      }

      return
    }

    /* 同一格继续写：原地刷新。这是「刷刷刷」的主体，一次动画都不播。 */
    if (shownValue.current.key === next.key) {
      if (!settled) {
        shownValue.current = next
        setShown(next)
      }

      return
    }

    if (rolling.current || pending.current.length > 0) {
      enqueue(next)
      return
    }

    promote(next)
  }, [contentKey, still, text])

  useEffect(
    () => () => {
      if (slotTimer.current !== null) {
        window.clearTimeout(slotTimer.current)
      }
    },
    [],
  )

  const overflow = useLineOverflow(following, shown.text)

  return (
    <span
      className="rolling-line"
      data-following={following ? '' : undefined}
      data-overflow={following && overflow.overflowing ? '' : undefined}
      ref={overflow.viewport}
    >
      {/* initial={false}：这一格刚挂上去的那一帧不播进场 —— 组头自己正在出现，
          让它内部再演一遍是同一个动作做两次。 */}
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          animate={{ opacity: 1, y: 0 }}
          className={cx('rolling-line__text', shimmer && 'timeline-shimmer')}
          exit={{ opacity: 0, y: '-0.8em' }}
          initial={{ opacity: 0, y: '0.8em' }}
          key={shown.key}
          transition={still ? AT_ONCE : ROLL}
        >
          {shown.text}
        </motion.span>
      </AnimatePresence>
    </span>
  )
})
