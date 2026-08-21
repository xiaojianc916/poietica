import { Plus } from 'lucide-react'
import { useCallback, useMemo, useRef } from 'react'
import type { ConversationId, WorkbenchTabId, WorkbenchTabViewModel } from '../../workbench'
import { useWorkbenchTabsBaselineGap } from './use-workbench-tabs-baseline-gap'
import { useWorkbenchTabsInteractions } from './use-workbench-tabs-interactions'
import { useWorkbenchTabsViewport } from './use-workbench-tabs-viewport'
import { WorkbenchTab } from './workbench-tab'

import './chrome-workbench-tabs.css'

export interface WorkbenchTabsProps {
  readonly tabs: readonly WorkbenchTabViewModel[]

  readonly onActivate: (tabId: WorkbenchTabId) => void

  readonly onClose: (tabId: WorkbenchTabId) => void

  readonly onMove: (tabId: WorkbenchTabId, targetIndex: number) => void

  readonly onCreate: () => void

  /** 正在跑的那些对话。标签图标由它决定画哪一枚。 */
  readonly runningThreadIds: ReadonlySet<ConversationId>
}

export function WorkbenchTabs({
  tabs,
  onActivate,
  onClose,
  onMove,
  onCreate,
  runningThreadIds,
}: WorkbenchTabsProps) {
  const newTabRef = useRef<HTMLButtonElement | null>(null)

  const activeTabId = tabs.find((tab) => tab.isActive)?.id

  const tabsGeometryKey = useMemo(
    () => tabs.map((tab) => [tab.id, tab.title].join(':')).join('|'),
    [tabs],
  )

  const viewport = useWorkbenchTabsViewport({
    activeTabId,
    tabsGeometryKey,
  })

  const focusNewTab = useCallback(() => {
    newTabRef.current?.focus()
  }, [])

  const interactions = useWorkbenchTabsInteractions({
    tabs,
    onActivate,
    onClose,
    onMove,
    getTabElement: viewport.getTabElement,
    scrollerRef: viewport.scrollerRef,
    focusNewTab,
  })

  useWorkbenchTabsBaselineGap({
    stripRef: viewport.stripRef,
    scrollerRef: viewport.scrollerRef,
    getTabElement: viewport.getTabElement,
    activeTabId,
    tabsGeometryKey,
    isReordering: interactions.isReordering,
  })

  /*
   * role="tablist" 只拥有标签：新建按钮不是 tab，留在里面会让屏幕阅读器把它报成标签集合的
   * 成员。
   *
   * 基线不归这里画——它是 chrome 行的边界，标签条只在激活标签的区间把它盖住；那段区间只
   * 有一个所有者，就是下面那个 hook，它是唯一写这两个自定义属性的地方。
   *
   * 滚动容器按内容取宽、可压缩：标签少时新建按钮紧跟最后一个标签，标签溢出时它自然停在
   * 右端。
   */
  return (
    <div className="chrome-workbench-tabs" ref={viewport.stripRef}>
      <div
        aria-label="工作台标签页"
        className="chrome-workbench-tabs__scroller"
        onWheel={viewport.onWheel}
        ref={viewport.scrollerRef}
        role="tablist"
      >
        {tabs.map((tab, index) => (
          <WorkbenchTab
            isDragging={interactions.draggingTabId === tab.id}
            isRunning={tab.kind === 'conversation' && runningThreadIds.has(tab.threadId)}
            key={tab.id}
            model={tab}
            onActivate={onActivate}
            onKeyDown={interactions.onKeyDown}
            onRequestClose={interactions.requestClose}
            registerTab={viewport.registerTab}
            reorder={interactions.reorder}
            targetIndex={index}
          />
        ))}
      </div>

      <button
        aria-label="新建对话"
        className="chrome-workbench-tabs__new-tab"
        onClick={onCreate}
        ref={newTabRef}
        type="button"
      >
        <Plus aria-hidden="true" />
      </button>
    </div>
  )
}
