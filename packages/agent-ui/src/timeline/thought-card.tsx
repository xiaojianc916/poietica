import './flow-row.css'
import './shimmer.css'
import './tool-call.css'

import { useEffect, useRef } from 'react'
import { DisclosureBody, useDisclosure } from '../primitives/disclosure'
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
  cacheKey,
  isStreaming,
  text,
}: {
  readonly cacheKey: string
  readonly isStreaming: boolean
  readonly text: string
}) {
  const { isOpen, toggle } = useDisclosure(false)
  const lineRef = useRef<HTMLSpanElement | null>(null)
  const line = readThoughtLine(text, isStreaming ? 'tail' : 'head')

  /* 写到哪儿看到哪儿：一行装不下时把视窗推到末尾。effect 在绘制之后跑，读到的是已经
     排好的布局，不强制回流。 */
  // biome-ignore lint/correctness/useExhaustiveDependencies: text 是触发器：删了它，新词到达时视窗就停在旧末端
  useEffect(() => {
    const element = lineRef.current

    if (isStreaming && element !== null) {
      element.scrollLeft = element.scrollWidth - element.clientWidth
    }
  }, [isStreaming, text])

  if (isStreaming) {
    return (
      <section className="timeline-tool">
        <div className="timeline-row" role="status">
          <ThinkingIcon aria-hidden="true" className="timeline-row__icon" />

          <span className="timeline-row__name">正在思考</span>

          <span aria-hidden="true" className="timeline-row__dot" />

          <span
            className="timeline-row__label timeline-shimmer"
            data-follow-end="true"
            ref={lineRef}
          >
            {line}
          </span>
        </div>
      </section>
    )
  }

  return (
    <section className="timeline-tool" data-open={isOpen ? 'true' : undefined}>
      <button aria-expanded={isOpen} className="timeline-row" onClick={toggle} type="button">
        <ThinkingIcon aria-hidden="true" className="timeline-row__icon" />

        <span className="timeline-row__name">思考完毕</span>

        <span aria-hidden="true" className="timeline-row__dot" />

        <span className="timeline-row__label">{line}</span>

        <ChevronDownIcon aria-hidden="true" className="timeline-row__chevron disclosure__chevron" />
      </button>

      <DisclosureBody isOpen={isOpen}>
        <Prose cacheKey={cacheKey} className="timeline-thought" isStreaming={false} text={text} />
      </DisclosureBody>
    </section>
  )
}
