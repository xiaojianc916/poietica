import { type RefObject, useLayoutEffect } from 'react'
import type { WorkbenchTabId } from '../../workbench'

interface UseWorkbenchTabsBaselineGapOptions {
  readonly stripRef: RefObject<HTMLDivElement | null>

  readonly scrollerRef: RefObject<HTMLDivElement | null>

  readonly getTabElement: (tabId: WorkbenchTabId) => HTMLButtonElement | undefined

  readonly activeTabId: WorkbenchTabId | undefined

  readonly tabsGeometryKey: string

  readonly isReordering: boolean
}

/*
 * 基线缺口的唯一所有者。
 *
 * 缺口就是"激活标签此刻渲染在哪"，一个事实、一处测量。getBoundingClientRect 按 CSSOM View
 * 的定义返回变换之后的边框盒，拖拽位移已经含在里面，所以不存在第二个"再把位移加回去"的项。
 *
 * 难的从来不是测什么，是什么时候测。位置会因为三类事情改变：布局（尺寸、滚动、标签集合）、
 * 会话位移（transform）、落位动画。只有第一类有平台观察器：transform 不引起回流，既不触发
 * ResizeObserver 也不触发 scroll，平台也没有位置观察器。所以会话期间只能按帧重投影，并且必须
 * 一直投到落位动画结束——少投一帧，缺口就永久停在错位置上，此后再没有任何信号会来纠正它。
 */
export function useWorkbenchTabsBaselineGap({
  stripRef,
  scrollerRef,
  getTabElement,
  activeTabId,
  tabsGeometryKey,
  isReordering,
}: UseWorkbenchTabsBaselineGapOptions): void {
  /*
   * tabsGeometryKey 是变更信号，不是本 effect 读取的值：标签集合或任一标题变化都会改变标签
   * 宽度，激活标签的区间随之改变，而纯位移不触发任何观察器。（规则豁免登记在 biome.json。）
   */
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

  /*
   * 会话期间按帧重投影。isReordering 覆盖到落位动画结束，而不是到松手为止：动画那 120ms 里
   * 标签仍在移动，而它靠的是 transform，没有任何观察器会报告这件事。
   */
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

/*
 * 两个自定义属性只在这一个函数里写。缺省 0px 渲染出的正是"无活动标签"的整条基线，所以测不到
 * 激活标签时移除即可，不需要第二个状态属性来表达同一件事。
 */
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
