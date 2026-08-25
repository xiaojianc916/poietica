import './flow-row.css'
import './shimmer.css'
import './tool-call.css'

import { DisclosureBody } from '../primitives/disclosure'
import { ChevronDownIcon, ThinkingIcon } from '../primitives/icons'
import { Prose } from './prose'
import { readThoughtLine } from './thought-line'

/**
 * 一段推理：写的时候是一行字，写完了是一个可以点开的抽屉。
 *
 * 形状与工具调用逐字相同（flow-row）：左图标、一句话、右箭头。差别只有一处 —— 还在
 * 写的时候它不是按钮，那一行每一帧都在变，此刻点开等于让人读一份正在被改写的草稿。
 * 那一行只印纯文本（thought-line），围栏与表格留到点开之后由 Prose 按 markdown 画。
 */
export function ThoughtCard({
  isOpen,
  isStreaming,
  onToggle,
  text,
}: {
  readonly isOpen: boolean
  readonly isStreaming: boolean
  readonly onToggle: () => void
  readonly text: string
}) {
  const line = readThoughtLine(text, isStreaming ? 'tail' : 'head')

  if (isStreaming) {
    return (
      <section className="timeline-tool">
        <div className="timeline-row" role="status">
          <ThinkingIcon aria-hidden="true" className="timeline-row__icon" />

          <span className="timeline-row__name">正在思考</span>

          <span aria-hidden="true" className="timeline-row__dot" />

          <span className="timeline-row__label timeline-shimmer">{line}</span>
        </div>
      </section>
    )
  }

  return (
    <section className="timeline-tool">
      <button aria-expanded={isOpen} className="timeline-row" onClick={onToggle} type="button">
        <ThinkingIcon aria-hidden="true" className="timeline-row__icon" />

        <span className="timeline-row__name">思考完毕</span>

        <span aria-hidden="true" className="timeline-row__dot" />

        <span className="timeline-row__label">{line}</span>

        <ChevronDownIcon aria-hidden="true" className="timeline-row__chevron disclosure__chevron" />
      </button>

      <DisclosureBody isOpen={isOpen}>
        <Prose className="timeline-thought" isStreaming={false} text={text} />
      </DisclosureBody>
    </section>
  )
}
