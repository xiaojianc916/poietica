import type { WorkbenchTabId, WorkbenchTabViewModel } from '@poietica/workspace'
import {
  resolveWorkbenchTabAutoScrollVelocity,
  resolveWorkbenchTabCloseTarget,
  resolveWorkbenchTabDragLayout,
  resolveWorkbenchTabKeyboardAction,
  type WorkbenchTabDragLayout,
  type WorkbenchTabSlot,
} from '@poietica/workspace'
import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

/*
 * 重排是一次指针会话，不是 HTML5 拖放。拖放那套的缺陷不是调参能补的：落点只在标签本身
 * 生效（拖到新建按钮或标签条空白处松手一律无事发生），Escape 无法可靠取消，拖动过程拿
 * 不到连续坐标。
 *
 * 会话产出的是一份布局，不是一个插入提示：被拖的那一格跟着指针走，让位的每一格滑到自己
 * 的新位置。这是 Chrome 标签条的做法 —— Chromium 的 TabStrip 用 ideal bounds 加
 * BoundsAnimator 表达同一件事，而被拖的那个 tab 由 TabDragController 直接按指针定位、
 * 不走动画。
 *
 * 捕获在越过阈值时才建立，不在 pointerdown。捕获期间 mousedown 与 mouseup 都会被重定向到
 * 捕获元素，click 随之在承载会话的容器上派发，而它没有 onClick，于是标签内两个真正的按钮
 * （激活与关闭）会双双失灵。捕获的唯一用途是让拖动越过其它标签时事件仍回到源标签。
 */
const DRAG_THRESHOLD = 4

/**
 * 拖拽期间每一格的横向位移。
 *
 * 写在 DOM 上而不是 React state 上：这是会话内的瞬时视觉位置，不是领域状态；领域里的顺序
 * 只在松手时经 onMove 提交一次。逐帧过 state 会让整条标签条按帧重渲，而这个数的唯一消费者
 * 是 CSS 的 transform。
 */
const TAB_SHIFT_PROPERTY = '--chrome-tab-shift'

/*
 * 边缘自动滚动的两个参数。
 *
 * 触发区取最小标签宽 88 的一半：再窄要求指针精确贴边，再宽会在标签条两端的正常落位动作里
 * 误触发。上限 720px/s 约等于一个首选宽度 168px 每 233ms，是"我要去另一头"这个意图该有的
 * 速度，再快会冲过头。
 *
 * 不写成 CSS 自定义属性：它们是交互模型的参数，不是可换肤的视觉量，读令牌只会多一次
 * getComputedStyle 而没有第二个消费者。
 */
const AUTO_SCROLL_ZONE = 44

const AUTO_SCROLL_MAX_SPEED = 720

interface PendingCloseFocus {
  readonly closingTabId: WorkbenchTabId

  readonly fallbackTabId: WorkbenchTabId | null
}

interface ReorderSession {
  readonly pointerId: number

  readonly tabId: WorkbenchTabId

  readonly fromIndex: number

  readonly originX: number

  /* 与 originX 成对：位移必须同时算进指针走过的距离和内容滚过的距离。 */
  readonly originScrollLeft: number

  readonly element: HTMLElement

  active: boolean

  pointerX: number

  slots: readonly WorkbenchTabSlot[]

  elements: readonly HTMLElement[]

  layout: WorkbenchTabDragLayout | null

  frame: number | null
}

export interface WorkbenchTabReorderBindings {
  readonly onPointerDown: (
    event: PointerEvent<HTMLElement>,
    tab: WorkbenchTabViewModel,
    index: number,
  ) => void

  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void

  readonly onPointerUp: (event: PointerEvent<HTMLElement>) => void

  /**
   * 未越过阈值时指针移出标签：此时还没有捕获，松手的 pointerup 不会回到标签，会话必须在
   * 这里收尾，否则会残留并挡住下一次按压。
   */
  readonly onPointerLeave: (event: PointerEvent<HTMLElement>) => void

  readonly onPointerCancel: () => void

  readonly onLostPointerCapture: () => void
}

interface UseWorkbenchTabsInteractionsOptions {
  readonly tabs: readonly WorkbenchTabViewModel[]

  readonly onActivate: (tabId: WorkbenchTabId) => void

  readonly onClose: (tabId: WorkbenchTabId) => void

  readonly onMove: (tabId: WorkbenchTabId, targetIndex: number) => void

  readonly getTabElement: (tabId: WorkbenchTabId) => HTMLButtonElement | undefined

  readonly scrollerRef: RefObject<HTMLDivElement | null>

  readonly focusNewTab: () => void
}

export function useWorkbenchTabsInteractions({
  tabs,
  onActivate,
  onClose,
  onMove,
  getTabElement,
  scrollerRef,
  focusNewTab,
}: UseWorkbenchTabsInteractionsOptions) {
  const sessionRef = useRef<ReorderSession | null>(null)

  const pendingCloseFocusRef = useRef<PendingCloseFocus | null>(null)

  const settleRef = useRef<Animation | null>(null)

  const [draggingTabId, setDraggingTabId] = useState<WorkbenchTabId | null>(null)

  /*
   * 与 draggingTabId 不是同一件事，所以是两个状态。draggingTabId 驱动 data-dragging，必须在
   * 松手那一刻和位移变量在同一次样式计算里一起消失，否则让位的标签会带着过渡滑回原处。
   * isReordering 表达的是"还有东西在动"，要一直持续到落位动画结束，基线缺口靠它决定投不投。
   */
  const [isReordering, setIsReordering] = useState(false)

  const requestClose = useCallback(
    (tabId: WorkbenchTabId) => {
      const tab = tabs.find((candidate) => candidate.id === tabId)

      if (!tab?.canClose) {
        return
      }

      if (tab.isActive) {
        pendingCloseFocusRef.current = {
          closingTabId: tabId,
          fallbackTabId: resolveWorkbenchTabCloseTarget(tabs, tabId),
        }
      }

      onClose(tabId)
    },
    [onClose, tabs],
  )

  /*
   * 焦点跟随只在被关掉的标签确实消失之后才动：关闭是异步提交的，提前搬焦点会搬到一个
   * 马上要被卸载的节点上。
   */
  useEffect(() => {
    const pending = pendingCloseFocusRef.current

    if (!pending) {
      return
    }

    if (tabs.some((tab) => tab.id === pending.closingTabId)) {
      return
    }

    pendingCloseFocusRef.current = null

    const activeTab = tabs.find((tab) => tab.isActive)

    const fallbackTab = pending.fallbackTabId
      ? tabs.find((tab) => tab.id === pending.fallbackTabId)
      : undefined

    const target = activeTab ?? fallbackTab

    if (!target) {
      requestAnimationFrame(focusNewTab)

      return
    }

    if (!target.isActive) {
      onActivate(target.id)
    }

    requestAnimationFrame(() => {
      getTabElement(target.id)?.focus()
    })
  }, [focusNewTab, getTabElement, onActivate, tabs])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, tabId: WorkbenchTabId) => {
      const action = resolveWorkbenchTabKeyboardAction(tabs, tabId, event.key)

      if (!action) {
        return
      }

      event.preventDefault()

      if (action.type === 'close') {
        requestClose(action.tabId)

        return
      }

      onActivate(action.tabId)

      requestAnimationFrame(() => {
        getTabElement(action.tabId)?.focus()
      })
    },
    [getTabElement, onActivate, requestClose, tabs],
  )

  const endSession = useCallback(() => {
    const session = sessionRef.current

    if (!session) {
      return
    }

    if (session.frame !== null) {
      cancelAnimationFrame(session.frame)
    }

    if (session.element.hasPointerCapture(session.pointerId)) {
      session.element.releasePointerCapture(session.pointerId)
    }

    for (const element of session.elements) {
      element.style.removeProperty(TAB_SHIFT_PROPERTY)
    }

    sessionRef.current = null

    setDraggingTabId(null)
  }, [])

  /* 会话持有一个 rAF 循环和一次指针捕获，组件卸载不会替它们收场。 */
  useEffect(() => {
    return () => {
      endSession()
    }
  }, [endSession])

  /*
   * 会话每一帧的唯一出口。指针移动与自动滚动都只改会话里的输入（pointerX / scrollLeft），
   * 重算与落笔都在这里做一次。两条触发源各算一遍位移，就是"同一段位移算两遍"那类错误。
   *
   * 位移同时含指针走过的距离和内容滚过的距离：槽位快照在内容坐标系里，指针在视口坐标系里，
   * 自动滚动会让两者之间的偏移在会话中途改变。
   */
  const applyLayout = useCallback((session: ReorderSession, scroller: HTMLDivElement) => {
    const layout = resolveWorkbenchTabDragLayout(
      session.slots,
      session.fromIndex,
      session.pointerX - session.originX + (scroller.scrollLeft - session.originScrollLeft),
    )

    if (!layout) {
      return
    }

    session.layout = layout

    for (const [index, offset] of layout.offsets.entries()) {
      session.elements[index]?.style.setProperty(TAB_SHIFT_PROPERTY, `${String(offset)}px`)
    }
  }, [])

  /*
   * 会话的帧循环：先按边缘自动滚动，再落一次布局。
   *
   * 速度曲线是纯函数，这里只负责按真实帧间隔把它积分成位移——乘 deltaTime 而不是每帧固定
   * 像素，否则 144Hz 上会比 60Hz 快 2.4 倍。不自己夹取边界：scrollLeft 的赋值由平台夹进
   * 可滚动范围，再夹一遍就是第二份真相。
   *
   * 布局每帧只落一次，且只在这里落。pointermove 的派发率由设备决定，高回报率鼠标每秒上千
   * 次，跟着它逐事件重算，同一帧里会把整条标签条的位移算上十几遍，而屏幕只取最后一遍。
   * 滚动同理：指针没动，但内容坐标系动了，被拖的那一格必须跟着内容走，否则它会被滚动条从
   * 指针底下抽走。两件事同一帧发生时，也只算一遍。
   */
  const startSessionLoop = useCallback(
    (session: ReorderSession, scroller: HTMLDivElement) => {
      let lastTime: number | null = null

      const tick = (time: number) => {
        const elapsed = lastTime === null ? 0 : (time - lastTime) / 1000

        lastTime = time

        const rect = scroller.getBoundingClientRect()

        const velocity = resolveWorkbenchTabAutoScrollVelocity(
          rect.left,
          rect.right,
          session.pointerX,
          AUTO_SCROLL_ZONE,
          AUTO_SCROLL_MAX_SPEED,
        )

        if (velocity !== 0 && elapsed > 0) {
          scroller.scrollLeft += velocity * elapsed
        }

        applyLayout(session, scroller)

        session.frame = requestAnimationFrame(tick)
      }

      session.frame = requestAnimationFrame(tick)
    },
    [applyLayout],
  )

  /*
   * 收尾只有一条路径：松手、Escape、pointercancel、丢失捕获全走这里，区别只在要不要提交
   * 顺序。落位动画从"松手瞬间的视觉位置"补到"布局给出的位置"，取消与提交共用同一段代码，
   * 也就不会出现某条路径忘了收干净。
   */
  const concludeSession = useCallback(
    (commit: boolean) => {
      const session = sessionRef.current

      if (!session) {
        return
      }

      const { element, tabId, fromIndex, layout } = session

      if (!session.active || !layout || !element.isConnected) {
        endSession()

        setIsReordering(false)

        return
      }

      const releasedLeft = element.getBoundingClientRect().left

      endSession()

      if (commit && layout.index !== fromIndex) {
        onMove(tabId, layout.index)
      }

      requestAnimationFrame(() => {
        const settled = getTabElement(tabId)?.closest<HTMLElement>('.chrome-workbench-tab')

        const animation = settled
          ? settleIntoPlace(settled, releasedLeft - settled.getBoundingClientRect().left)
          : null

        settleRef.current = animation

        if (!animation) {
          setIsReordering(false)

          return
        }

        /*
         * finish 与 cancel 是互斥的终态，用事件而不是 finished：后者在取消时 reject，还得
         * 再接一个 catch 才不会变成未处理的拒绝。新会话已经开始时不要把它的循环关掉。
         */
        const stop = () => {
          if (!sessionRef.current) {
            setIsReordering(false)
          }
        }

        animation.addEventListener('finish', stop, { once: true })
        animation.addEventListener('cancel', stop, { once: true })
      })
    },
    [endSession, getTabElement, onMove],
  )

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>, tab: WorkbenchTabViewModel, index: number) => {
      const scroller = scrollerRef.current

      if (event.button !== 0 || !tab.canClose || !scroller || sessionRef.current) {
        return
      }

      sessionRef.current = {
        pointerId: event.pointerId,
        tabId: tab.id,
        fromIndex: index,
        originX: event.clientX,
        originScrollLeft: scroller.scrollLeft,
        element: event.currentTarget,
        active: false,
        pointerX: event.clientX,
        slots: [],
        elements: [],
        layout: null,
        frame: null,
      }
    },
    [scrollerRef],
  )

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const session = sessionRef.current

      const scroller = scrollerRef.current

      if (!session || !scroller || session.pointerId !== event.pointerId) {
        return
      }

      session.pointerX = event.clientX

      /*
       * 阈值以下不进入拖拽，普通点击仍然只是点击。越过阈值时把几何快照一次：一次拖拽内
       * 标签尺寸不变，逐帧重测只会白白触发同步布局。
       */
      if (!session.active) {
        if (Math.abs(event.clientX - session.originX) < DRAG_THRESHOLD) {
          return
        }

        const measured = measureStrip(tabs, getTabElement, scroller)

        if (!measured) {
          endSession()

          return
        }

        /* WAAPI 动画压过内联样式，上一段落位不掐掉会和这次拖拽抢同一个属性。 */
        settleRef.current?.cancel()

        settleRef.current = null

        session.active = true
        session.slots = measured.slots
        session.elements = measured.elements

        session.element.setPointerCapture(session.pointerId)

        setDraggingTabId(session.tabId)

        setIsReordering(true)

        startSessionLoop(session, scroller)
      }
    },
    [endSession, getTabElement, scrollerRef, startSessionLoop, tabs],
  )

  const onPointerUp = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (sessionRef.current?.pointerId !== event.pointerId) {
        return
      }

      concludeSession(true)
    },
    [concludeSession],
  )

  const onPointerLeave = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const session = sessionRef.current

      if (!session || session.pointerId !== event.pointerId || session.active) {
        return
      }

      endSession()
    },
    [endSession],
  )

  const cancelSession = useCallback(() => {
    concludeSession(false)
  }, [concludeSession])

  /*
   * Escape 只在会话活着时监听。键盘事件不会落到承载会话的容器上（焦点仍在内层按钮），
   * 所以必须挂 window。
   */
  useEffect(() => {
    if (!draggingTabId) {
      return
    }

    function onWindowKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') {
        cancelSession()
      }
    }

    window.addEventListener('keydown', onWindowKeyDown)

    return () => {
      window.removeEventListener('keydown', onWindowKeyDown)
    }
  }, [cancelSession, draggingTabId])

  const reorder: WorkbenchTabReorderBindings = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerLeave,
    onPointerCancel: cancelSession,
    onLostPointerCapture: cancelSession,
  }

  return {
    requestClose,
    onKeyDown,
    reorder,
    draggingTabId,
    isReordering,
  }
}

/*
 * 槽位与元素一次测齐，坐标落在滚动容器的内容坐标系里，不是视口坐标系：自动滚动会在会话中途
 * 改变两者之间的偏移，用视口坐标快照的槽位一滚就整体错位，夹取范围也会缩到"当前可见的那几个
 * 标签"，被拖的标签因此到不了真正的首尾。
 *
 * 任一标签取不到元素就整体作废：索引必须与 tabs 一一对应，缺一个就会把位移写到别的标签上。
 * 宁可这次按压不进入拖拽，也不要错位。
 */
function measureStrip(
  tabs: readonly WorkbenchTabViewModel[],
  getTabElement: (tabId: WorkbenchTabId) => HTMLButtonElement | undefined,
  scroller: HTMLDivElement,
): { slots: readonly WorkbenchTabSlot[]; elements: readonly HTMLElement[] } | null {
  const slots: WorkbenchTabSlot[] = []

  const elements: HTMLElement[] = []

  const origin = scroller.getBoundingClientRect().left - scroller.scrollLeft

  for (const tab of tabs) {
    const element = getTabElement(tab.id)?.closest<HTMLElement>('.chrome-workbench-tab')

    if (!element) {
      return null
    }

    const rect = element.getBoundingClientRect()

    slots.push({ id: tab.id, start: rect.left - origin, end: rect.right - origin })

    elements.push(element)
  }

  return elements.length > 0 ? { slots, elements } : null
}

/*
 * 松手后补一段落位：被拖的那一格从松手时的视觉位置滑到布局给它的位置，否则它会瞬移，前面
 * 一路跟手的物理感在最后一帧全部作废。让位的标签不需要这一段 —— 它们的位移取自静止槽位
 * 起点，松手后真实布局给出的就是它们已经在的位置。
 *
 * 用 Web Animations API 而不是再造一个 class 开关加 transitionend：一次性动画的起止与中断
 * 清理由平台负责。时长与曲线读设计令牌，和相邻标签的 CSS 过渡是同一组数；令牌读不到就不放
 * 动画，不在这里另写一个字面量当第二份真相。
 *
 * 返回动画句柄：基线缺口要靠它知道"还有东西在动"，新会话要靠它掐掉上一段。
 */
function settleIntoPlace(element: HTMLElement, delta: number): Animation | null {
  if (delta === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return null
  }

  const styles = getComputedStyle(element)

  const duration = Number.parseFloat(styles.getPropertyValue('--ui-duration-fast'))

  const easing = styles.getPropertyValue('--ui-ease-standard').trim()

  if (!Number.isFinite(duration) || easing === '') {
    return null
  }

  return element.animate(
    [{ transform: `translateX(${String(delta)}px)` }, { transform: 'translateX(0)' }],
    { duration, easing },
  )
}
