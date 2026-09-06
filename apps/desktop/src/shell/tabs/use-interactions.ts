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

const DRAG_THRESHOLD = 4

const TAB_SHIFT_PROPERTY = '--chrome-tab-shift'

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
