import type { WorkbenchTabId } from '@poietica/workspace'
import { type RefObject, useCallback, useEffect, useRef, type WheelEvent } from 'react'

const SCROLL_EDGE_PADDING = 4

interface UseWorkbenchTabsViewportOptions {
  readonly activeTabId: WorkbenchTabId | undefined

  readonly tabsGeometryKey: string
}

interface WorkbenchTabsViewport {
  readonly scrollerRef: RefObject<HTMLDivElement | null>

  readonly stripRef: RefObject<HTMLDivElement | null>

  readonly getTabElement: (tabId: WorkbenchTabId) => HTMLButtonElement | undefined

  readonly registerTab: (tabId: WorkbenchTabId, element: HTMLButtonElement | null) => void

  readonly onWheel: (event: WheelEvent<HTMLDivElement>) => void
}

export function useWorkbenchTabsViewport({
  activeTabId,
  tabsGeometryKey,
}: UseWorkbenchTabsViewportOptions): WorkbenchTabsViewport {
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  const stripRef = useRef<HTMLDivElement | null>(null)

  const tabRefs = useRef(new Map<WorkbenchTabId, HTMLButtonElement>())

  const previousActiveTabIdRef = useRef<WorkbenchTabId | undefined>(activeTabId)

  const getTabElement = useCallback((tabId: WorkbenchTabId) => {
    return tabRefs.current.get(tabId)
  }, [])

  const registerTab = useCallback((tabId: WorkbenchTabId, element: HTMLButtonElement | null) => {
    if (element) {
      tabRefs.current.set(tabId, element)

      return
    }

    tabRefs.current.delete(tabId)
  }, [])

  useEffect(() => {
    const previousActiveTabId = previousActiveTabIdRef.current

    if (previousActiveTabId && previousActiveTabId !== activeTabId) {
      const previousActivation = tabRefs.current.get(previousActiveTabId)

      const previousTab = previousActivation?.closest<HTMLElement>('.chrome-workbench-tab')

      if (previousTab?.matches(':hover')) {
        previousTab.setAttribute('data-suppress-hover', 'true')
      }
    }

    if (activeTabId) {
      const activeActivation = tabRefs.current.get(activeTabId)

      activeActivation
        ?.closest<HTMLElement>('.chrome-workbench-tab')
        ?.removeAttribute('data-suppress-hover')
    }

    previousActiveTabIdRef.current = activeTabId
  }, [activeTabId])

  useEffect(() => {
    if (!activeTabId) {
      return
    }

    const scroller = scrollerRef.current

    const activation = tabRefs.current.get(activeTabId)

    const tab = activation?.closest<HTMLElement>('.chrome-workbench-tab')

    if (!scroller || !tab) {
      return
    }

    const viewportStart = scroller.scrollLeft

    const viewportEnd = viewportStart + scroller.clientWidth

    const tabStart = tab.offsetLeft

    const tabEnd = tabStart + tab.offsetWidth

    let nextScrollLeft = viewportStart

    if (tabStart < viewportStart + SCROLL_EDGE_PADDING) {
      nextScrollLeft = Math.max(0, tabStart - SCROLL_EDGE_PADDING)
    } else if (tabEnd > viewportEnd - SCROLL_EDGE_PADDING) {
      nextScrollLeft = tabEnd - scroller.clientWidth + SCROLL_EDGE_PADDING
    }

    if (nextScrollLeft !== viewportStart) {
      scroller.scrollTo({
        left: nextScrollLeft,
        behavior: 'auto',
      })
    }
  }, [activeTabId, tabsGeometryKey])

  const onWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current

    if (!scroller || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return
    }

    scroller.scrollLeft += event.deltaY
  }, [])

  return {
    scrollerRef,
    stripRef,
    getTabElement,
    registerTab,
    onWheel,
  }
}
