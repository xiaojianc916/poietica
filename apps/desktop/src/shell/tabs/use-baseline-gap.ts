import type { WorkbenchTabId } from '@poietica/workspace'
import { type RefObject, useLayoutEffect } from 'react'

interface UseWorkbenchTabsBaselineGapOptions {
  readonly stripRef: RefObject<HTMLDivElement | null>

  readonly scrollerRef: RefObject<HTMLDivElement | null>

  readonly getTabElement: (tabId: WorkbenchTabId) => HTMLButtonElement | undefined

  readonly activeTabId: WorkbenchTabId | undefined

  readonly tabsGeometryKey: string

  readonly isReordering: boolean
}

export function useWorkbenchTabsBaselineGap({
  stripRef,
  scrollerRef,
  getTabElement,
  activeTabId,
  tabsGeometryKey,
  isReordering,
}: UseWorkbenchTabsBaselineGapOptions): void {
  useLayoutEffect(() => {
    const strip = stripRef.current

    const scroller = scrollerRef.current

    if (!strip || !scroller) {
      return
    }

    let frame: number | null = null

    /* 一帧内可能来多次滚动事件，合并到一帧里读，避免同一帧反复强制布局。 */
    const scheduleProjection = () => {
      if (frame !== null) {
        return
      }

      frame = requestAnimationFrame(() => {
        frame = null

        projectBaselineGap(strip, findActiveTab(getTabElement, activeTabId))
      })
    }

    projectBaselineGap(strip, findActiveTab(getTabElement, activeTabId))

    scroller.addEventListener('scroll', scheduleProjection, { passive: true })

    /* 只观察真正影响缺口的盒子：标签条根、滚动容器、当前激活标签。 */
    const resizeObserver = new ResizeObserver(scheduleProjection)

    resizeObserver.observe(strip)
    resizeObserver.observe(scroller)

    const activeTab = findActiveTab(getTabElement, activeTabId)

    if (activeTab) {
      resizeObserver.observe(activeTab)
    }

    return () => {
      scroller.removeEventListener('scroll', scheduleProjection)

      resizeObserver.disconnect()

      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [activeTabId, getTabElement, scrollerRef, stripRef, tabsGeometryKey])

  useLayoutEffect(() => {
    const strip = stripRef.current

    if (!isReordering || !strip) {
      return
    }

    let frame = requestAnimationFrame(function tick() {
      projectBaselineGap(strip, findActiveTab(getTabElement, activeTabId))

      frame = requestAnimationFrame(tick)
    })

    return () => {
      cancelAnimationFrame(frame)
    }
  }, [activeTabId, getTabElement, isReordering, stripRef])
}

function projectBaselineGap(strip: HTMLElement, activeTab: HTMLElement | undefined): void {
  if (!activeTab) {
    strip.style.removeProperty('--chrome-active-tab-left')

    strip.style.removeProperty('--chrome-active-tab-right')

    return
  }

  const stripRect = strip.getBoundingClientRect()

  const tabRect = activeTab.getBoundingClientRect()

  const left = Math.max(0, tabRect.left - stripRect.left)

  const right = Math.min(stripRect.width, tabRect.right - stripRect.left)

  strip.style.setProperty('--chrome-active-tab-left', `${String(left)}px`)

  strip.style.setProperty('--chrome-active-tab-right', `${String(right)}px`)
}

function findActiveTab(
  getTabElement: (tabId: WorkbenchTabId) => HTMLButtonElement | undefined,
  activeTabId: WorkbenchTabId | undefined,
): HTMLElement | undefined {
  if (!activeTabId) {
    return undefined
  }

  return getTabElement(activeTabId)?.closest<HTMLElement>('.chrome-workbench-tab') ?? undefined
}
