import './flow-row.css'
import './shimmer.css'
import './tool-call.css'

import { cx } from '../primitives/class-names'
import { DisclosureBody } from '../primitives/disclosure'
import { ChevronDownIcon, ThinkingIcon } from '../primitives/icons'
import { useFollowEnd } from '../primitives/use-follow-end'
import { readThoughtLine } from './thought-line'

/**
 * 一段推理：一行字，点开是全文。
 *
 * 形状与工具调用逐字相同（flow-row）。写的时候印末行并横向跟到末尾，落定之后印首行。
 * 点开的那一段是原文本身（pre-wrap）：推理是模型的自语，不是文档，按文档解析要在点击
 * 那一帧里把整篇过一遍解析器、高亮器与公式排版 —— 那正是长推理点开时的那一顿。
 *
 * 可访问名钉死成状态那一句：那一格每帧都在变，让它当按钮的名字等于让读屏的落脚点一直在动。
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
  const label = useFollowEnd<HTMLSpanElement>(isStreaming)
  const name = isStreaming ? '正在思考' : '思考完毕'

  return (
    <section className="timeline-tool">
      <button
        aria-expanded={isOpen}
        aria-label={name}
        className="timeline-row"
        onClick={onToggle}
        type="button"
      >
        <ThinkingIcon aria-hidden="true" className="timeline-row__icon" />

        <span className="timeline-row__name">{name}</span>

        <span aria-hidden="true" className="timeline-row__dot" />

        <span
          className={cx('timeline-row__label', isStreaming && 'timeline-shimmer')}
          data-follow-end={isStreaming ? '' : undefined}
          ref={label}
        >
          {line}
        </span>

        <ChevronDownIcon aria-hidden="true" className="timeline-row__chevron disclosure__chevron" />
      </button>

      <DisclosureBody isOpen={isOpen}>
        <div className="timeline-thought">{text}</div>
      </DisclosureBody>
    </section>
  )
}
