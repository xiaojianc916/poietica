import { useCallback, useRef, useSyncExternalStore } from 'react'

/**
 * 距末端多近算作「回到了最新」。
 *
 * 它只回答「回来了没有」，不回答「走开了没有」——后者由方向回答，见 nextFollow。约等于
 * 一格滚轮，所以人滚回底部附近就重新接管，不必压到零。
 */
const NEAR_END_PX = 48

/**
 * 人主动改变一段内容高度的标准声明。
 *
 * aria-expanded 是 WAI-ARIA 给「这个控件控制一段可展开区域」的属性，封条与抽屉的开关全都
 * 带着它（timeline/turn-seal.tsx、primitives/disclosure.tsx）。拿它当判据，比去嗅探活动
 * 动画表可靠：意图来自那一次点击，不来自动画的副作用，减弱动态偏好把过渡关掉时它照样成立。
 */
const DISCLOSURE = '[aria-expanded]'

/** 一次滚动几何读数。字段名与 Element 对齐，所以可以直接从元素上抄。 */
export interface ScrollGeometry {
  readonly clientHeight: number
  readonly scrollHeight: number
  readonly scrollTop: number
}

/** 一次读三个量。分三次读会读到三帧之间的布局，而这三个数必须互相自洽。 */
function seen(element: HTMLElement): ScrollGeometry {
  return {
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }
}

/**
 * 末端还剩多远。
 *
 * 这是 DOM 的真值：三个量来自同一个盒子，所以内边距、尾部预留、以及未测量内容的估高误差
 * 全都含在里面。虚拟窗口的推算值做不到 —— 它的总高是内层定高盒子的高度，既不含盒子自己的
 * 内边距，也在声明了 scrollMargin 时把那一段减掉却不加回。
 *
 * 不夹到 0：橡皮筋滚动会让它变成负数，而负数与 0 对下面那条判据是同一个答案，夹一次只会
 * 掩盖一个真实状态。
 */
export function distanceFromEnd(geometry: ScrollGeometry): number {
  return geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop
}

/** 这个几何算不算「视口在末端」。 */
export function staysWithLatest(geometry: ScrollGeometry): boolean {
  return distanceFromEnd(geometry) <= NEAR_END_PX
}

/**
 * 跟随的下一状态。三个入参就是全部判据，所以它是纯函数，能脱离 DOM 钉住。
 *
 * 判「人走开了没有」只能看方向，不能看距离。距离判据在带动画的滚轮下必然失效：Chromium
 * 把一格滚轮拆成十几个几像素的增量事件，第一个增量离末端还不到十个像素 —— 于是「还在末端」
 * 成立，跟随不放手，下一次提交又把视口拨回末端，人就被粘在底部。这也是标杆的做法：
 * use-stick-to-bottom（Vercel AI Elements 的 Conversation 用的就是它）判的是方向加「是不是
 * 自己写的」，距离只用来重新上闩。
 *
 * shrank 那一项不是保险，是必须：内容变短时浏览器会把 scrollTop 夹小，这在事件层与人往上
 * 拨一模一样，而它是折叠引起的，不是手势。
 */
export function nextFollow(before: ScrollGeometry, after: ScrollGeometry, ours: boolean): boolean {
  /* 我们只在跟随时写，所以自己那一笔的答案恒定是「继续跟」。 */
  if (ours) {
    return true
  }

  const wentUp = after.scrollTop < before.scrollTop
  const shrank = after.scrollHeight < before.scrollHeight

  return wentUp && !shrank ? false : staysWithLatest(after)
}

/** 末端跟随交出来的东西，各有明确的调用点。 */
export interface FollowLatest {
  /** 视口此刻是否在末端。几何，不是意图 —— 它只喂「回到最新」那枚按钮的存在。 */
  readonly atLatest: boolean
  /** 若人还跟着最新内容，把视口拨到末端；无论跟不跟，都重新发布一次几何。 */
  readonly stick: () => void
  /** 人接管了滚动位置。粘滞，由「人自己滚回末端」解除。 */
  readonly release: () => void
  /** 重新跟上，并立刻拨到末端。 */
  readonly resume: () => void
  readonly watch: (viewport: HTMLElement) => () => void
}

/**
 * 滚动位置在末端这一侧的唯一所有者。
 *
 * 滚动位置归盒子的主人。这条规则没有例外：会话流的滚动区归 AgentActivityFeed，思考链那个
 * 有上限的盒子归 ReasoningPanel，工具载荷那个 tabpanel 归 ToolCallPanels —— 谁挂的元素，谁
 * 决定它跟不跟最新内容走。铺内容的那一层（虚拟窗口）因此一个 scrollTop 都不写：它不知道
 * 自己被装在什么盒子里，也就没有资格替那个盒子做这个决定。
 *
 * 「贴住最新内容」不外包给虚拟器的 anchorTo 'end' 与 followOnAppend。那套原语覆盖不到这个
 * 界面最活跃的东西，而这不是配置没调好，是它的坐标系里没有那些东西：
 *
 *   - 瞬态过程区与等待指示器坐在 paddingEnd 里。paddingEnd 是一个数字而不是条目，它变大既
 *     不经过 resizeItem（那个只由带 data-index 的节点触发），也不满足追加判据 —— 库里没有
 *     任何一条路径会为它拨动滚动位置。
 *   - 「贴没贴底」在库内部有两个不同源的定义：resizeItem 读 getVirtualDistanceFromEnd()，
 *     追加那条门读 isAtEnd()。前者是模型推算，后者是 DOM 真值。
 *   - 增量补偿写在 ResizeObserver 回调里，而长高要等 React 提交才落到 DOM，所以那次
 *     scrollTop 写入会被浏览器夹掉；库把意图记在自己的 scrollOffset 里，DOM 从此落后一截。
 *     这一条是库源码自己的注释写下的。
 *   - 它还不受调用方的策略约束：一个声明了「不要追末端」的盒子，仍然会在内容追加时被拨到
 *     最后一行。策略与判据在那套原语里是同一个开关，而它们不是同一件事。
 *
 * 不做补间。流式输出每帧长几十像素，瞬移贴底看起来就是纸在往上走；而一旦有动画，就必须再
 * 引入一个「人已经挣脱」的粘滞状态去防动画把人拽回来。不做动画，那个状态也就不必存在。
 *
 * 状态一共三个，各自只有一个存储位置：意图（跟不跟）、几何（在不在末端）、以及「上一次
 * 读到的几何」。意图不参与渲染，所以它是 ref；几何要画那枚按钮，所以它经
 * useSyncExternalStore 发布 —— 那是 React 给「外部可变值参与渲染」的官方接口，一处存储加
 * 一条通知，而不是 ref 一份、state 一份互相同步。
 */
export function useFollowLatest(): FollowLatest {
  const viewport = useRef<HTMLElement | null>(null)

  /* 开场就跟着：一个盒子刚挂上时该看见最新内容，这是唯一一次不需要任何人下令的跟随。 */
  const follows = useRef(true)

  /*
   * 自己写的那一笔。
   *
   * 只在写入真的改变了值时才立起来：值没变浏览器不派发 scroll，标记会一直挂着，然后吞掉人
   * 下一次向上滚 —— 那是同一类 bug 的另一种形态。
   */
  const ours = useRef(false)

  const last = useRef<ScrollGeometry>({ clientHeight: 0, scrollHeight: 0, scrollTop: 0 })

  const atLatest = useRef(true)
  const listeners = useRef(new Set<() => void>())

  const subscribe = useCallback((onChange: () => void) => {
    listeners.current.add(onChange)

    return () => {
      listeners.current.delete(onChange)
    }
  }, [])

  const snapshot = useCallback(() => atLatest.current, [])

  const publish = useCallback((next: boolean) => {
    if (atLatest.current === next) {
      return
    }

    atLatest.current = next

    for (const notify of listeners.current) {
      notify()
    }
  }, [])

  const stick = useCallback(() => {
    const element = viewport.current

    if (element === null) {
      return
    }

    if (follows.current) {
      const before = element.scrollTop

      /*
       * 写一个必然越界的值，让浏览器去夹。
       *
       * CSSOM View 规定 scrollTop 的 setter 把值夹进可滚动范围，所以这一句就是「拨到末端」
       * 的全文，不必先读再算再写回去。写完立刻读，读到的是夹过的真值。
       */
      element.scrollTop = element.scrollHeight

      if (element.scrollTop !== before) {
        ours.current = true
      }
    }

    const geometry = seen(element)

    last.current = geometry
    publish(staysWithLatest(geometry))
  }, [publish])

  const release = useCallback(() => {
    follows.current = false
  }, [])

  /*
   * 重新跟上要连着拨一次，不能只举旗。
   *
   * 举旗的效果要等下一次高度变化才看得见，而重新跟上的那些时机恰恰不伴随高度变化：人又说
   * 了一句话、人按下那枚按钮、一段边写边看的内容被重新展开。所以这里自己拨一次，把「跟上」
   * 与「到末端」合成同一帧。
   */
  const resume = useCallback(() => {
    follows.current = true
    stick()
  }, [stick])

  const watch = useCallback(
    (element: HTMLElement) => {
      viewport.current = element
      last.current = seen(element)
      publish(staysWithLatest(last.current))

      const onScroll = () => {
        const geometry = seen(element)

        follows.current = nextFollow(last.current, geometry, ours.current)
        ours.current = false
        last.current = geometry
        publish(staysWithLatest(geometry))
      }

      /*
       * 人亲手展开或收起一段内容时，末端不再是家。
       *
       * 没有这一条，读者在末端点开封条会被立刻拨回末端 —— 而他要看的东西在上面。委托在滚动
       * 区上，所以封条、思考链、工具卡片一并覆盖，不需要谁来登记。
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
    },
    [publish],
  )

  return {
    atLatest: useSyncExternalStore(subscribe, snapshot),
    release,
    resume,
    stick,
    watch,
  }
}
