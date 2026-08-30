import './flow-row.css'
import './shimmer.css'
import './tool-call.css'

import { cx } from '../primitives/class-names'
import { DisclosureBody } from '../primitives/disclosure'
import { ChevronDownIcon, ThinkingIcon } from '../primitives/icons'
import { useFollowEnd } from '../primitives/use-follow-end'
import { readThoughtLine } from './thought-line'

/**
 * 一段推理：一行字，落定之后点开是全文。
 *
 * 形状与工具调用共用 flow-row，量度不共用：这一行是模型的原话，量度归阅读栏
 * （data-measure），工具那一档是给路径与命令的。写的时候印末行并横向跟到末尾，落定
 * 之后印首行。点开的那一段是原文本身（pre-wrap）：推理是模型的自语，不是文档。
 *
 * 运行中这一行不是控件 —— 这是与 DeepSeek 有意分歧的一处（对照 deepseek-harness 的
 * packages/client/ui-conversation/src/client/chat/ReasoningRow.tsx，它始终 expandable）。
 * 这里的行由虚拟器铺、挂着 measureElement：一个正在以帧率长高的抽屉会让末端锚定每帧补一
 * 次滚动增量，人一边读一边被往上拽；而那一格每帧在变，让它当按钮的可访问名等于让读屏的
 * 落脚点一直在动。所以运行中只有状态、没有开合入口，落定之后才交出按钮与箭头。
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

  return (
    <section className="timeline-tool">
      {isStreaming ? (
        <div className="timeline-row" data-measure="prose">
          {face}
        </div>
      ) : (
        <button
          aria-expanded={isOpen}
          aria-label={name}
          className="timeline-row"
          data-measure="prose"
          onClick={onToggle}
          type="button"
        >
          {face}

          <ChevronDownIcon
            aria-hidden="true"
            className="timeline-row__chevron disclosure__chevron"
          />
        </button>
      )}

      <DisclosureBody isOpen={isOpen}>
        <div className="timeline-thought">{text}</div>
      </DisclosureBody>
    </section>
  )
}
