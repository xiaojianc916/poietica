import type { ToolCallTimelineItem } from '@poietica/agent'
import { useId, useState } from 'react'

import { panelId, TabList, type TabOption, tabId } from '../primitives/tabs'
import type { DiffFile } from '../semantics/file-diff'
import type { ToolCallFacets } from '../semantics/tool-call-facets'
import { Prose } from './prose'

/**
 * 抽屉里的那张纸。
 *
 * 一处改动没有两个面：那次调用就是这处改动，所以切换条的位置印路径，下面是带行号的统一
 * diff —— opencode 的分享页、GitHub 与 VS Code 的行内 diff 都是这个排布。其余调用照旧
 * 分送出去与交回来两面。
 */

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
  labelledBy,
  panel,
  text,
}: {
  readonly labelledBy?: string
  readonly panel?: string
  readonly text: string
}) {
  return (
    <div
      className="timeline-tool__panel"
      data-scrollable=""
      {...(panel === undefined
        ? {}
        : { 'aria-labelledby': labelledBy, id: panel, role: 'tabpanel' })}
    >
      <Prose className="timeline-tool__prose" isStreaming={false} text={text} />
    </div>
  )
}

/** 一处改动：路径一行，下面是它的行。行的分类与行号归 semantics/file-diff。 */
function FileDiff({ file }: { readonly file: DiffFile }) {
  return (
    <div className="timeline-tool__file">
      <div className="timeline-tool__path" title={file.path}>
        {file.dir === '' ? null : <span className="timeline-tool__path-dir">{file.dir}</span>}
        <span className="timeline-tool__path-name">{file.name}</span>
      </div>

      <div className="timeline-tool__diff" data-scrollable="">
        {file.rows.map((row) => (
          <div className="timeline-tool__diff-row" data-kind={row.kind} key={row.at}>
            <span className="timeline-tool__diff-line">{row.number ?? '⋯'}</span>
            <code className="timeline-tool__diff-code">{row.text}</code>
          </div>
        ))}

        {file.clamped ? (
          <p className="timeline-tool__diff-note">…（改动过长，上面只是开头）</p>
        ) : null}
      </div>
    </div>
  )
}

export function ToolCallPanels({
  facets,
  isRunning,
  kind,
}: {
  readonly facets: ToolCallFacets
  readonly isRunning: boolean
  readonly kind: ToolCallTimelineItem['kind']
}) {
  const { diffs, request, response } = facets
  const baseId = useId()
  const [chosen, setChosen] = useState<string | null>(null)

  /* 改动那一支不给页签：路径就是标题，diff 就是内容；交回来的那句话仍在它下面。 */
  if (diffs.length > 0) {
    return (
      <div className="timeline-tool__body">
        {diffs.map((file) => (
          <FileDiff file={file} key={file.path} />
        ))}

        {response === null ? null : <ToolPanel text={response} />}
      </div>
    )
  }

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
