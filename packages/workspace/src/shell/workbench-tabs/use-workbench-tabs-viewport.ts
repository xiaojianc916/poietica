import { type RefObject, useCallback, useEffect, useRef, type WheelEvent } from 'react'
import type { WorkbenchTabId } from '../../workbench'

const SCROLL_EDGE_PADDING = 4

interface UseWorkbenchTabsViewportOptions {
  readonly activeTabId: WorkbenchTabId | undefined

  readonly tabsGeometryKey: string
}

interface WorkbenchTabsViewport {
  readonly scrollerRef: RefObject<HTMLDivElement | null>

  /**
   * 标签条根元素。基线分隔线画在它上面，因为只有它横跨整条标签条——滚动容器
   * 已经不再横跨（新建按钮是它的兄弟节点）。区间由基线 hook 单独持有。
   */
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

  /*
   * tabsGeometryKey 是变更信号，不是本 effect 读取的值：标签集合或任一标题变化
   * 都会改变标签宽度，激活标签可能因此被推出可视区，需要重新滚动对齐。
   *
   * Biome 把 hook 参数当作外层作用域值，所以把它报成多余依赖；同一个数组里的
   * activeTabId 来源完全相同却没有被报，区别只在于它在 effect 体内被读取过。
   * （规则豁免登记在 biome.json。）
   */
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
