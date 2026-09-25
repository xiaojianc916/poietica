import './flow-row.css'
import './shimmer.css'

import { useEffect, useState } from 'react'
import { cx } from '../primitives/class-names'
import { DisclosureBody } from '../primitives/disclosure'
import { ChevronDownIcon, ThinkingIcon } from '../primitives/icons'
import { useFollowEnd } from '../primitives/use-follow-end'
import { readThoughtLine } from '../semantics/thought-line'
import { VIRTUAL_ABOVE_LINES, VirtualLines } from './virtual-lines'

interface ThoughtHeadProps {
  readonly isOpen: boolean
  readonly isStreaming: boolean
  readonly line: string
  readonly name: string
  readonly onToggle: () => void
}

/** 推理头：一枚图标、一个名、一行原话，落定之后多一枚箭头。 */
function ThoughtHead({ isOpen, isStreaming, line, name, onToggle }: ThoughtHeadProps) {
  const label = useFollowEnd<HTMLSpanElement>(isStreaming)

  const face = (
    <>
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
    </>
  )

  if (isStreaming) {
    return (
      <div className="timeline-row" data-measure="prose">
        {face}
      </div>
    )
  }

  return (
    <button
      aria-expanded={isOpen}
      aria-label={name}
      className="timeline-row"
      data-measure="prose"
      onClick={onToggle}
      type="button"
    >
      {face}

      <ChevronDownIcon aria-hidden="true" className="timeline-row__chevron disclosure__chevron" />
    </button>
  )
}

/**
 * 一段推理：一行字，落定之后点开是全文。
 *
 * 形状与工具调用共用 flow-row，量度不共用：这一行是模型的原话，量度归阅读栏
 * （data-measure），工具那一档是给路径与命令的。写的时候印末行并横向跟到末尾，落定
 * 之后印首行。点开的那一段是原文本身（pre-wrap）：推理是模型的自语，不是文档。
 *
 * 运行中这一行不是控件 —— 这是与 DeepSeek 有意分歧的一处（对照 deepseek-harness 的
 * packages/client/ui-chat/src/client/chat/ReasoningRow.tsx，它始终 expandable）。
 * 这里的行由虚拟器铺、挂着 measureElement：一个正在以帧率长高的抽屉会让末端锚定每帧补一
 * 次滚动增量，人一边读一边被往上拽；而那一格每帧在变，让它当按钮的可访问名等于让读屏的
 * 落脚点一直在动。所以运行中只有状态、没有开合入口，落定之后才交出按钮与箭头。
 *
 * 正文封顶并自己滚（flow-row.css 的 .timeline-thought）：一段推理动辄几十行，全铺开会
 * 把这一行下面的东西整片推走，而那一段只是过程。封顶之后头也就不用吸顶了 —— 它不再随
 * 正文滚出视口，于是那套 portal 副本与相交观察一并删掉。
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
  const name = isStreaming ? '正在思考' : '思考完毕'
  const [body, setBody] = useState<HTMLDivElement | null>(null)
  const lines = text.split('\n')

  /*
   * 流式追加要把容器钉在末端 —— 不钉，新写的字落在容器外面，人只看到开头。
   * 落定之后不再动：那时这是读者的滚动位置，不是我们的。
   */
  useEffect(() => {
    if (body !== null && isStreaming) {
      body.scrollTop = body.scrollHeight
    }
  })

  return (
    <section className="timeline-tool">
      <ThoughtHead
        isOpen={isOpen}
        isStreaming={isStreaming}
        line={line}
        name={name}
        onToggle={onToggle}
      />

      <DisclosureBody isOpen={isOpen}>
        <div className="timeline-thought" ref={setBody}>
          {lines.length > VIRTUAL_ABOVE_LINES ? (
            <VirtualLines
              className="timeline-thought__lines"
              lineClassName="timeline-thought__line"
              lines={lines}
              measured
              viewport={body}
            />
          ) : (
            text
          )}
        </div>
      </DisclosureBody>
    </section>
  )
}
