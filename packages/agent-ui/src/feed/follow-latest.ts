import { useCallback, useRef } from 'react'

/**
 * 距末端多近仍算作「人还在看最新一条」。约等于一格滚轮。
 *
 * 官方 Chat 指南给 scrollEndThreshold 的参考值是 80。这里不抄那个数：那是给库内部
 * 两条判据共用的容差，而这里唯一的消费者是「人有没有走开」，人走开的最小动作就是拨
 * 一格滚轮。
 */
const NEAR_END_PX = 48

/**
 * 人主动改变一段内容高度的标准声明。
 *
 * aria-expanded 是 WAI-ARIA 给「这个控件控制一段可展开区域」的属性，封条与抽屉的开关
 * 全都带着它（timeline/turn-seal.tsx 的 turn-seal--toggle、primitives/disclosure.tsx）。
 * 拿它当判据，比去嗅探活动动画表里有没有 grid-template-rows 过渡可靠：意图来自那一次
 * 点击，不来自动画的副作用，所以减弱动态偏好把过渡关掉时它照样成立。
 */
const DISCLOSURE = '[aria-expanded]'

/** 一次滚动几何读数。字段名与 Element 对齐，所以可以直接把元素传进来。 */
export interface ScrollGeometry {
  readonly clientHeight: number
  readonly scrollHeight: number
  readonly scrollTop: number
}

/**
 * 末端还剩多远。
 *
 * 这是 DOM 的真值，不是任何模型的推算值 —— 三个量来自同一个盒子，所以内边距、尾部
 * 预留、以及未测量行的估高误差全都已经含在里面。虚拟器那两条推算值做不到这一点：
 * getVirtualDistanceFromEnd() 走 getTotalSize()，而后者减掉了 scrollMargin 却没有
 * 加回，于是只要滚动区有上内边距，它就恒定小那么一段。
 *
 * 不夹到 0：橡皮筋滚动会让它变成负数，而负数与 0 对下面那条判据是同一个答案，夹一次
 * 只会掩盖一个真实状态。
 */
export function distanceFromEnd(geometry: ScrollGeometry): number {
  return geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop
}

/** 这个几何算不算「人还在看最新一条」。 */
export function staysWithLatest(geometry: ScrollGeometry): boolean {
  return distanceFromEnd(geometry) <= NEAR_END_PX
}

/** 末端跟随交回来的三样东西，各有一个调用点。 */
export interface FollowLatest {
  /** 若人还在跟着最新内容，把视口拨到末端；否则什么都不做。 */
  readonly stick: () => void
  /** 人接管了滚动位置。粘滞，由「人自己滚回末端」解除。 */
  readonly release: () => void
  readonly watch: (viewport: HTMLElement) => () => void
}

/**
 * 滚动位置在末端这一侧的唯一所有者。
 *
 * 「贴住最新内容」此前外包给虚拟器的 anchorTo 'end' 与 followOnAppend。那套原语覆盖
 * 不到这个界面最活跃的东西，而这不是配置没调好，是它的坐标系里没有那些东西：
 *
 *   - 瞬态过程区与等待指示器坐在 paddingEnd 里。paddingEnd 是一个数字而不是条目，
 *     它变大既不经过 resizeItem（那个只由带 data-index 的节点触发），也不满足
 *     setOptions 里 nextCount > prevCount 的追加判据 —— 库里没有任何一条路径会为它
 *     拨动滚动位置。工具调用上屏时视口一动不动，就是这一条。
 *   - 「贴没贴底」在库内部有两个不同源的定义：resizeItem 的 wasAtEnd 读
 *     getVirtualDistanceFromEnd()，followOnAppend 的门读 isAtEnd() →
 *     getDistanceFromEnd()。前者是模型推算并且漏了 scrollMargin，后者是 DOM 真值。
 *   - 增量补偿写在 ResizeObserver 回调里，而长高要等 React 提交才落到 DOM，所以那次
 *     scrollTop 写入会被浏览器夹掉。库把意图记在自己的 scrollOffset 里，DOM 从此落后
 *     一截 —— 这一条是库源码自己的注释写下的。
 *
 * 所以跟随不再问模型，只问 DOM。这与 use-stick-to-bottom（Vercel AI Elements 的
 * Conversation 用的就是它）取的是同一个真值、同一种判据。借它的算法，不引它的包，两条
 * 理由都是源码事实：它在 import 期就往 document 上挂 mousedown/mouseup，而本包对外
 * 声明的副作用只有 CSS；它还要求内容被 StickToBottom.Content 包一层，而那一层正是
 * 虚拟器的定高盒子 —— 两个所有者又回来了。
 *
 * 分工因此是干净的，两个写入者从不写同一件事：
 *
 *   虚拟器 —— 视口上方的估高误差。它的默认判据只补偿完全在视口上方的行，那正是
 *             「读者位置不动」，与末端无关，所以保留。
 *   这里   —— 末端。
 *
 * 不做补间。流式输出每帧长几十像素，瞬移贴底看起来就是纸在往上走；而一旦有动画，就必须
 * 再引入一个「人已经挣脱」的粘滞状态去防动画把人拽回来 —— use-stick-to-bottom 的
 * escapedFromLock 正是为此存在。不做动画，那个状态也就不必存在。
 *
 * 于是这里只有一个布尔，而它甚至不是 state：没有任何渲染后果，读它的只有 stick()。
 */
export function useFollowLatest(): FollowLatest {
  const viewport = useRef<HTMLElement | null>(null)

  /* 开场就跟着：一段会话打开时该看见最新一条，而这是唯一一次不需要任何人下令的跟随。 */
  const follows = useRef(true)

  const stick = useCallback(() => {
    const element = viewport.current

    if (element === null || !follows.current) {
      return
    }

    /*
     * 写一个必然越界的值，让浏览器去夹。
     *
     * CSSOM View 规定 scrollTop 的 setter 把值夹进可滚动范围，所以这一句就是「拨到
     * 末端」的全文，不需要先读 scrollHeight 减 clientHeight 再写回去 —— 少一次读，也
     * 少一处会与真值算错的算术。已经在末端时写入不改变任何值，浏览器因此连 scroll
     * 事件都不派发。
     */
    element.scrollTop = element.scrollHeight
  }, [])

  const release = useCallback(() => {
    follows.current = false
  }, [])

  const watch = useCallback((element: HTMLElement) => {
    viewport.current = element

    /*
     * 判据只有一条：此刻离末端多远。
     *
     * 不判方向。内容变短时浏览器会把 scrollTop 夹小，那与人向上拨一格在事件层无从
     * 区分，而按距离判的答案对两者都对：夹完仍在末端，跟随保持；人拨走了一格以上，
     * 跟随让开。也不必忽略自己写入引起的那次 scroll —— 那一次读回来的距离是 0，判据
     * 给出的正是它本来的答案。
     */
    const onScroll = () => {
      follows.current = staysWithLatest(element)
    }

    /*
     * 人亲手展开或收起一段内容时，末端不再是家。
     *
     * 没有这一条，读者在末端点开封条会被立刻拨回末端 —— 而他要看的东西在上面。
     * 委托在滚动区上，所以封条、思考链、工具卡片一并覆盖，不需要谁来登记。
     */
    const onToggle = (event: Event) => {
      const target = event.target

      if (target instanceof Element && target.closest(DISCLOSURE) !== null) {
        follows.current = false
      }
    }

    element.addEventListener('scroll', onScroll, { passive: true })
    element.addEventListener('click', onToggle)

    return () => {
      element.removeEventListener('scroll', onScroll)
      element.removeEventListener('click', onToggle)
      viewport.current = null
    }
  }, [])

  return { release, stick, watch }
}
