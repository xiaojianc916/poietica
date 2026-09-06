import type { ConversationId, WorkbenchTabId, WorkbenchTabViewModel } from '@poietica/workspace'
import { Plus } from 'lucide-react'
import { useCallback, useMemo, useRef } from 'react'
import { useWorkbenchTabsBaselineGap } from './use-baseline-gap'
import { useWorkbenchTabsInteractions } from './use-interactions'
import { useWorkbenchTabsViewport } from './use-viewport'
import { WorkbenchTab } from './workbench-tab'

import './workbench-tabs.css'

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
