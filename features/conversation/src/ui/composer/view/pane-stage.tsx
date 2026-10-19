import './pane-stage.css'

import { motion, useReducedMotion, type Variants } from 'motion/react'
import { memo, type ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { ENTER_EASE, ENTER_SECONDS, EXIT_SECONDS, RISE_PX } from '../../shared/primitives/motion'

/*
 * 一张弹层卡里换页。卡只有一张，换的是页：盒子的宽高由「当前这一页」量出来，旧页淡出、新页淡入与盒子变形走同一条
 * 时长与曲线，三件事读起来是同一个动作，而不是「关了一张、开了一张」。
 *
 * 为什么量页而不是让卡 auto：auto 到 auto 之间没有补间，换页那一帧卡就是跳。第一次量到之前盒子是 auto ——
 * 开窗不是一次换页，不该从 0 长出来。页要自己说宽（页的 inline-size），盒子才有宽可量：页是 max-content，
 * 盒子此刻补间中的宽撑不开它，也压不窄它。
 *
 * 旧页为什么是一张「残影」而不是让它多活一会儿（AnimatePresence 那种）：页里装的是菜单项，菜单按挂着的项排序号、
 * 认高亮、接焦点。旧页多活 200ms，两页的项就同时挂在一份序号表里 —— 高亮落到看不见的那一页、焦点被接到滑块上，
 * 键盘一按就错（实验台里逐帧看到过）。所以对菜单来说换页仍是瞬间换完，与原先一模一样；淡出的只是旧页在摘掉前
 * 那一刻的一份 DOM 拷贝，不挂任何 React 状态，不进无障碍树，播完就摘。
 */

export interface PaneStageProps {
  /**
   * 当前这一页在第几层：0 是开窗落下的那一页，数大的在里面。变了就是一次换页，往哪边换也由它定 ——
   * 往里走新页从行尾那侧进来，往回退从行首那侧回来，调用方不必另说方向。
   */
  readonly depth: number
  readonly children: ReactNode
}

interface Shown {
  readonly depth: number
  readonly direction: 1 | -1
  /* 开窗以来换过页没有：开窗落下的那一页不播入场。 */
  readonly moved: boolean
}

interface PaneSize {
  readonly width: number
  readonly height: number
}

interface Measured {
  readonly size: PaneSize
  /* 开窗后第一次量到：直接落定。那一刻盒子从 auto 变成定值，看上去一样大，补间只会白跑一遍。 */
  readonly first: boolean
}

/* 横移只是给方向一个暗示，真正在动的是盒子：两倍浮层起落的位移，比卡片的内边距还小，旧页不会被读成「滑走了」。 */
const SHIFT_PX = RISE_PX * 2

/* 「这一次换页有多长」：盒子变形与横移共用这一条，三件事才是同一个动作。 */
const MOVE = { duration: ENTER_SECONDS, ease: ENTER_EASE }
const AT_ONCE = { duration: 0 }

/* 还没量到：不给目标，盒子留在 auto。 */
const UNMEASURED = {}

/* 两页的字不能同时都是实的：旧页的不透明度先落，新页晚一拍再起，交叠的那一小段两边都只剩一半。 */
const FADE_OUT_SECONDS = EXIT_SECONDS * 0.6
const FADE_IN_DELAY_SECONDS = EXIT_SECONDS * 0.35

const PAGE_VARIANTS: Variants = {
  enter: (direction: number) => ({ opacity: 0, x: direction * SHIFT_PX }),
  present: {
    opacity: 1,
    x: 0,
    transition: {
      x: MOVE,
      opacity: { delay: FADE_IN_DELAY_SECONDS, duration: ENTER_SECONDS - FADE_IN_DELAY_SECONDS, ease: 'linear' },
    },
  },
}

export const PaneStage = memo(function PaneStage({ children, depth }: PaneStageProps) {
  /* 关掉动画是系统级偏好：换页照换，盒子一步到位，没有残影也没有入场。 */
  const reduced = useReducedMotion() === true
  const stage = useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = useState<Measured | undefined>(undefined)
  const [shown, setShown] = useState<Shown>({ depth, direction: 1, moved: false })

  /* 渲染期对比上一次的层（React 的「props 变了就调 state」写法）：方向得与这一次换页同一帧到。 */
  if (shown.depth !== depth) {
    setShown({ depth, direction: depth > shown.depth ? 1 : -1, moved: true })
  }

  const { direction, moved } = shown

  const onSize = useCallback((size: PaneSize) => {
    setMeasured((last) => ({ size, first: last === undefined }))
  }, [])

  const onLeave = useCallback(
    (page: HTMLElement) => {
      const host = stage.current

      if (reduced || host === null) {
        return
      }

      /* 拷贝得趁现在（DOM 还没摘）；留不留残影得等这一次提交做完再看。 */
      const ghost = page.cloneNode(true) as HTMLElement

      queueMicrotask(() => {
        /*
         * 页真被摘掉了、舞台还在，才是一次换页。清理也可能是别的缘故：依赖变了重跑、开发期 StrictMode 的假卸载
         * （页都还在原处）；整张卡关掉（舞台一起没了）—— 那由卡自己的退场动画连页一起淡掉，不另留残影。
         */
        if (!page.isConnected && host.isConnected) {
          leaveAsGhost(host, ghost)
        }
      })
    },
    [reduced],
  )

  const settle = reduced || measured?.first !== false ? AT_ONCE : MOVE

  return (
    <motion.div
      animate={measured?.size ?? UNMEASURED}
      className="pane-stage"
      initial={false}
      ref={stage}
      transition={settle}
    >
      <motion.div
        animate="present"
        className="pane-stage__page"
        custom={direction}
        initial={moved && !reduced ? 'enter' : false}
        key={depth}
        variants={PAGE_VARIANTS}
      >
        <Page onLeave={onLeave} onSize={onSize}>
          {children}
        </Page>
      </motion.div>
    </motion.div>
  )
})

interface PageProps {
  readonly children: ReactNode
  readonly onSize: (size: PaneSize) => void
  readonly onLeave: (page: HTMLElement) => void
}

/*
 * 量度与残影都挂在页的父层（带 key 的那个 motion.div）上：它随换页整个换掉，量到的就是这一页，摘掉前那一刻
 * 拷下来的也是这一页。量的是父层而不是这里：入场的横移在父层上，borderBoxSize 本就不吃变换。
 */
function Page({ children, onLeave, onSize }: PageProps) {
  const anchor = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const page = anchor.current?.parentElement

    if (page === null || page === undefined) {
      return undefined
    }

    /* borderBoxSize 不吃变换（开窗那一下卡还在 scale 0.95），且保留小数 —— offsetWidth 取整，会裁掉半个像素。 */
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(([entry]) => {
            const box = entry?.borderBoxSize[0]

            if (box !== undefined) {
              onSize({ width: box.inlineSize, height: box.blockSize })
            }
          })
    observer?.observe(page)

    return () => {
      observer?.disconnect()
      /* 布局清理在 DOM 摘除之前跑：这一刻页还在原位、还是最后那一帧的样子。 */
      onLeave(page)
    }
  }, [onLeave, onSize])

  return (
    <>
      <span aria-hidden="true" hidden ref={anchor} />
      {children}
    </>
  )
}

/*
 * 旧页的残影：摘掉前那一刻的 DOM 拷贝，叠在原位淡出，播完就摘。方向只交给新页的入场去说，残影原地淡掉就够。
 * 拷贝去掉 id（不与活页撞号），整份 inert + aria-hidden（点不到、读不到）。它不归 React 管：舞台里 React 只认
 * 自己挂的那一页，多出来的这个节点它不碰；卡关掉时随舞台一起摘掉。
 */
function leaveAsGhost(host: HTMLElement, ghost: HTMLElement) {
  if (typeof ghost.animate !== 'function') {
    return
  }

  ghost.classList.add('pane-stage__ghost')
  ghost.removeAttribute('id')
  for (const node of ghost.querySelectorAll('[id]')) {
    node.removeAttribute('id')
  }
  ghost.setAttribute('aria-hidden', 'true')
  ghost.inert = true
  host.append(ghost)

  const remove = () => {
    ghost.remove()
  }

  ghost
    .animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: FADE_OUT_SECONDS * 1000,
      easing: 'linear',
      fill: 'forwards',
    })
    .finished.then(remove, remove)
}
