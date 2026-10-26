/*
 * 视图过渡（View Transitions）的统一入口：换肤与换面各拍一次快照，浏览器补间两张位图，
 * DOM 本身一次落地。调用方只管把「状态换掉」那段交进来，不关心有没有 API。
 *
 * 三条出口都同步落地：没有 API（happy-dom、旧内核）、系统要求减弱动效、外观页关掉了动效。
 * 减弱动效必须在这里自己判：tokens/accessibility.css 那条 `*` 规则只压元素树里的声明，
 * ::view-transition-* 是伪元素树、压不到 —— 不判的话「减少动效」开着照样淡入。
 *
 * `update` 一律经 flushSync 落地：它常常只是改一个 Observable / dataset，React 那边是**排队**的；
 * 不在回调返回前画完，浏览器拍到的「新快照」还是旧画面，补出来是同一张脸。
 */

import { flushSync } from 'react-dom'

export interface ViewTransitionOptions {
  /** 写进 `ViewTransition.types` 的类型名，CSS 用 `:active-view-transition-type()` 认领自己那一份。 */
  readonly type?: string
}

/** 两个减弱动效来源任一成立即为真：系统偏好，或外观页那个开关（根上的 data-reduce-motion）。 */
function motionAllowed(): boolean {
  if (document.documentElement.dataset.reduceMotion === 'true') return false
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function withViewTransition(update: () => void, options: ViewTransitionOptions = {}): void {
  if (typeof document.startViewTransition !== 'function' || !motionAllowed()) {
    flushSync(update)
    return
  }

  /* 只跑一次：浏览器在回调里抛错时更新仍须落地，且回退路径不能再跑第二遍。 */
  let started = false
  const run = (): void => {
    if (started) return
    started = true
    flushSync(update)
  }

  try {
    const transition = document.startViewTransition({
      update: run,
      types: options.type === undefined ? [] : [options.type],
    })
    /* 被下一个过渡打断、或 update 抛错都会让这两个 promise reject；没人等它们，接住以免成为未处理拒绝。 */
    transition.ready.catch(() => undefined)
    transition.finished.catch(() => undefined)
  } catch {
    run()
  }
}
