import type { ToolCallTimelineItem } from '@poietica/agent'
import { useId, useRef, useState } from 'react'

import { panelId, TabList, type TabOption, tabId } from '../primitives/tabs'
import type { ToolCallFacets } from '../semantics/tool-call-facets'
import { VirtualProse } from './virtual-prose'

const REQUEST = 'request'
const RESPONSE = 'response'

const FACETS: readonly TabOption[] = [
  { id: REQUEST, label: 'Request' },
  { id: RESPONSE, label: 'Response' },
]

function emptyNoteOf(kind: ToolCallTimelineItem['kind'], isRunning: boolean): string {
  if (!isRunning) {
    return '这次调用没有返回内容。'
  }

  return kind === 'delegate' ? '子代理在自己那边干活，这里只记结果。' : '还在运行，暂时没有输出。'
}

/** 抽屉里唯一的滚动容器。高度由它自己的内容定 —— 没有第二面在旁边顶着。 */
function ToolPanel({
  labelledBy,
  panel,
  text,
}: {
  readonly labelledBy?: string
  readonly panel?: string
  readonly text: string
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)

  return (
    <div
      className="timeline-tool__panel"
      ref={scrollRef}
      {...(panel === undefined
        ? {}
        : { 'aria-labelledby': labelledBy, id: panel, role: 'tabpanel' })}
    >
      <VirtualProse
        bodyClassName="timeline-tool__prose"
        isStreaming={false}
        scrollRef={scrollRef}
        text={text}
      />
    </div>
  )
}

/**
 * 一次调用的两个面。
 *
 * 只挂当前那一面：APG 的 Tabs Pattern 允许未选中的面板不进 DOM，而两面同时在场就意味
 * 着高度取两者的最大值、隐藏那一面的虚拟器照样在量。换面时 key 变，滚动位置从头开始 ——
 * 这两面本来就要从头读。
 */
export function ToolCallPanels({
  facets,
  isRunning,
  kind,
}: {
  readonly facets: ToolCallFacets
  readonly isRunning: boolean
  readonly kind: ToolCallTimelineItem['kind']
}) {
  const { request, response } = facets
  const baseId = useId()
  const [chosen, setChosen] = useState<string | null>(null)
  const activeId =
    request === null ? RESPONSE : (chosen ?? (response === null ? REQUEST : RESPONSE))
  const responseText = response ?? emptyNoteOf(kind, isRunning)

  if (request === null) {
    return (
      <div className="timeline-tool__body">
        <ToolPanel text={responseText} />
      </div>
    )
  }

  return (
    <div className="timeline-tool__body">
      <TabList
        activeId={activeId}
        baseId={baseId}
        className="timeline-tool__tabs"
        label="这次调用的两个面"
        onSelect={setChosen}
        options={FACETS}
      />

      <ToolPanel
        key={activeId}
        labelledBy={tabId(baseId, activeId)}
        panel={panelId(baseId, activeId)}
        text={activeId === REQUEST ? request : responseText}
      />
    </div>
  )
}
