import { useCallback, useLayoutEffect, useRef } from 'react'

/** 一次折叠该走多久。比鱼眼慢一点:这是布局变化,不是指针跟随。 */
const DURATION_MS = 180
const EASING = 'cubic-bezier(0.2, 0, 0, 1)'
const ID_ATTR = 'data-rail-id'

/** 一格在这一帧的读数:身份与位置一次读齐。 */
type Shot = { bar: HTMLElement; id: string; top: number }

/**
 * 读的一趟。
 *
 * 每格一次 offsetTop,顺手记下身份 —— 读 offsetTop 会 flush 布局,读写交替就是
 * 每格一次回流;而对 live collection 走第二趟、把 data-rail-id 再读一次,是白
 * 付的一趟。
 */
const measure = (bars: HTMLCollectionOf<HTMLElement>, into: Map<string, number>): Shot[] => {
  const shots: Shot[] = []

  for (const bar of bars) {
    const id = bar.getAttribute(ID_ATTR)

    if (id !== null) {
      const top = bar.offsetTop

      into.set(id, top)
      shots.push({ bar, id, top })
    }
  }

  return shots
}

/**
 * 一格的位移补偿。
 *
 * 没有来处的那一格是从某个簇里裂出来的,淡进来;没挪动的直接跳过,不平白起一个
 * 动画。用 Web Animations API 而不是内联 transition:不需要强制回流来断开过渡,
 * 也不需要事后清理内联样式,而且 transform 走合成层,不碰布局。
 */
const play = (shot: Shot, from: number | undefined) => {
  if (from === undefined) {
    shot.bar.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DURATION_MS, easing: EASING })

    return
  }

  if (from === shot.top) {
    return
  }

  shot.bar.animate(
    [{ transform: `translateY(${String(from - shot.top)}px)` }, { transform: 'none' }],
    { duration: DURATION_MS, easing: EASING },
  )
}

/**
 * 折叠与展开之间的位移,补成连续的。
 *
 * 并格不是把几根杠叠起来,是几个节点被一个节点顶替 —— 所以 CSS 过渡无从下手:
 * 它只能过渡活着的元素的属性,过渡不了"五个变一个"。这里走 FLIP:先让 React
 * 把布局落到终点,再读出每一格挪了多远,用 transform 把它推回原位,然后放开。
 *
 * 顺序是关键。真实布局在第 0 帧就已经是最终布局,动画只是视觉上的回溯 —— 所以
 * 动画期间按下去,命中的是那一格将要去的地方,而不是眼睛看到的地方。反过来做
 * (拿真实布局做动画)目标会从光标底下走开,点击落空。
 *
 * 消失的那几格没有动画 —— 它们已经从 DOM 里出去了,要画出被吸进去的轨迹得把
 * 卸载的节点留成幽灵层。整列同时滑动才是这一下的主导运动,先不为那 3px 建一
 * 套机制。
 *
 * 依赖是格子的身份序列,不是「每次渲染」—— 理由见下面 useLayoutEffect 上方那段。
 */
export function useFoldFlip(
  signature: string,
): (node: HTMLElement | null) => (() => void) | undefined {
  const nodeRef = useRef<HTMLElement | null>(null)
  const beforeRef = useRef<Map<string, number>>(new Map())

  /*
   * 交回清理函数,和这个子系统里另外两个 ref 一样。
   *
   * 此前它什么都不返回,靠 React 19 保留的那次 null 调用撒手 —— 而调用方把三路
   * ref 合并成了一个返回清理函数的回调,React 于是不再以 null 调用它,那次撒手被
   * 吃掉了,节点在卸载之后仍被攥着。一个协议,三个参与者。
   */
  const ref = useCallback((node: HTMLElement | null) => {
    nodeRef.current = node

    return () => {
      nodeRef.current = null
    }
  }, [])

  /*
   * 依赖是这一帧格子的身份序列，不是「每次渲染」。
   *
   * 此前这里没有依赖数组，理由写着「这个组件被 memo 包着，滚动帧里根本不重渲染」。
   * 那句话是错的：activeRow 就是 memo 的入参之一，而它每跨一行就变一次（滚动区
   * 每帧都在算它）。于是读者每跨一行，这里就对 live collection 逐格读一次
   * offsetTop —— 全表强制回流，只为发现每一格的 delta 都是 0。
   *
   * 而 FLIP 要补的是「几个节点被一个节点顶替」造成的位移，那件事当且仅当格子的
   * 身份序列变了才发生。身份序列没变就一个字都不用读。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 签名即结构，节点由 ref 持有
  useLayoutEffect(() => {
    const node = nodeRef.current
    const view = node?.ownerDocument.defaultView ?? null

    if (node === null || view === null) {
      return
    }

    const bars = node.getElementsByClassName(
      'conversation-minimap__turn',
    ) as HTMLCollectionOf<HTMLElement>
    const before = beforeRef.current
    const after = new Map<string, number>()
    const shots = measure(bars, after)

    beforeRef.current = after

    /* 头一回挂载没有"之前",整条轨道不该从别处飞进来。 */
    if (before.size === 0 || view.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return
    }

    for (const shot of shots) {
      play(shot, before.get(shot.id))
    }
  }, [signature])

  return ref
}
