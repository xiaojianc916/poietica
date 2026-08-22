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

function ToolPanel({
  active,
  labelledBy,
  panel,
  text,
}: {
  readonly active: boolean
  readonly labelledBy?: string
  readonly panel?: string
  readonly text: string
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)

  if (panel === undefined) {
    return (
      <div
        className="timeline-tool__panel"
        data-active={active ? 'true' : undefined}
        inert={!active}
        ref={scrollRef}
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

  return (
    <div
      aria-hidden={active ? undefined : true}
      aria-labelledby={labelledBy}
      className="timeline-tool__panel"
      data-active={active ? 'true' : undefined}
      id={panel}
      inert={!active}
      ref={scrollRef}
      role="tabpanel"
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

/** Each tab owns its renderer, measurement cache, and scroll position. */
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
        <ToolPanel active text={responseText} />
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

      <div className="timeline-tool__panels">
        <ToolPanel
          active={activeId === REQUEST}
          labelledBy={tabId(baseId, REQUEST)}
          panel={panelId(baseId, REQUEST)}
          text={request}
        />
        <ToolPanel
          active={activeId === RESPONSE}
          labelledBy={tabId(baseId, RESPONSE)}
          panel={panelId(baseId, RESPONSE)}
          text={responseText}
        />
      </div>
    </div>
  )
}
