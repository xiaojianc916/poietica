import { type RefObject, useCallback, useRef, useState } from 'react'

/**
 * 抽屉那条过渡改的是哪个属性。
 *
 * 思考面板与工具卡片的展开收起都靠 grid-template-rows 从 0fr 走到 1fr
 * （primitives/disclosure.css）。滚动区认这一个属性名，就等于认「有人正在
 * 故意改变某一行的高度」，而不必知道是谁在改。
 *
 * 只认 CSS 过渡这一种驱动，而这是有意的。转录尾部那块瞬态区的让位由 motion
 * 驱动（timeline/live-process.tsx），它不派发 transitionrun，所以永远进不了
 * 这个判据 —— 让位要解决的是「某一行正在长高，末端不该跟着跑」，而瞬态区收拢
 * 时末端跟着走恰好是要的效果：回答落到底部的那段路就是它。
 */
const DRAWER_PROPERTY = 'grid-template-rows'

/**
 * 此刻是否有抽屉正在改某一行的高度。
 *
 * 问的是浏览器的活动动画表，不是我们自己记的账。记账那一版漏在减的那一头：
 * 行在动画途中被虚拟列表卸载时，按 CSS Transitions 规范过渡被取消，而
 * transitioncancel 在已经脱离文档的那个节点上派发 —— 冒泡不到滚动区，于是
 * 加了减不回来，计数只增不减，锚点永远卡在让位状态。
 *
 * getAnimations 没有这个可能：卸载的行连同它的过渡一起从表里消失，被取消的
 * 过渡也一样。没有账本，就不存在账本对不上。
 *
 * 只认 DRAWER_PROPERTY 这一条 —— 同一个元素上还有 opacity 的过渡，行里还有
 * 悬停底色，那些都不是在改高度。
 *
 * getAnimations 在 jsdom 里没有实现，所以先探后用。
 */
const drawersAreMoving = (transcript: HTMLElement): boolean => {
  if (typeof transcript.getAnimations !== 'function') {
    return false
  }

  return transcript
    .getAnimations({ subtree: true })
    .some((animation) => (animation as CSSTransition).transitionProperty === DRAWER_PROPERTY)
}

export interface DrawerMotion {
  /** 此刻有没有抽屉在改某一行的高度。 */
  readonly moving: boolean
  /** 装到滚动区上，返回卸载函数。与 useRevealIntent.watch 同一个契约。 */
  readonly watch: (viewport: HTMLElement) => () => void
}

/**
 * 抽屉在不在动，只是一个布尔值，但它需要一处订阅。
 *
 * 它服务的是滚动区的末端锚定要不要让位，而判据与后果都写在调用方 —— 这里
 * 只负责如实回答，并且和滚动、跳转用同一种装卸形状：一个 watch，交回一个
 * 卸载函数，一个滚动区一处生命周期。
 *
 * transitionrun 冒泡，所以挂在滚动区上就能收到任何一行里的那条过渡。收到
 * 就置真并起一个每帧一问的循环：读到活动动画表里没有抽屉，循环自己结束 ——
 * 不需要任何收尾事件，也就没有收不到收尾事件这回事。
 */
export function useDrawerMotion(transcript: RefObject<HTMLElement | null>): DrawerMotion {
  const [moving, setMoving] = useState(false)
  const frame = useRef<number | null>(null)

  const watch = useCallback(
    (viewport: HTMLElement) => {
      /*
       * 循环只在停下来的那一帧写一次状态。
       *
       * 起循环的那一句已经把 moving 置真，所以循环运行期间它必然是真 —— 每帧再
       * 写一遍同一个值，写的是同一个答案。相同的值只保证跳过子树，不保证跳过这个
       * 组件自身（useState 文档原话：React may still need to render that specific
       * component again before bailing out），而它重渲一次就是整屏行的一次协调。
       * 一次展开约十来帧，于是十来次。
       */
      const readDrawers = () => {
        const node = transcript.current

        if (node !== null && drawersAreMoving(node)) {
          frame.current = requestAnimationFrame(readDrawers)

          return
        }

        frame.current = null
        setMoving(false)
      }

      const onDrawerRun = (event: TransitionEvent) => {
        if (event.propertyName !== DRAWER_PROPERTY) {
          return
        }

        /* 循环在跑就说明已经是真的了，所以置真与起循环是同一件事。 */
        if (frame.current === null) {
          setMoving(true)
          frame.current = requestAnimationFrame(readDrawers)
        }
      }

      viewport.addEventListener('transitionrun', onDrawerRun)

      return () => {
        viewport.removeEventListener('transitionrun', onDrawerRun)

        if (frame.current !== null) {
          cancelAnimationFrame(frame.current)
          frame.current = null
        }

        setMoving(false)
      }
    },
    [transcript],
  )

  return { moving, watch }
}
