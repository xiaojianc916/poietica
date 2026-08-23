import './flow-row.css'
import './shimmer.css'

import { useCallback, useLayoutEffect, useRef } from 'react'

import { cx } from '../primitives/class-names'
import { DisclosureBody, useDisclosure } from '../primitives/disclosure'
import { useFollowLatest } from '../primitives/follow-latest'
import { ChevronDownIcon, ThinkingIcon } from '../primitives/icons'
import { Prose } from './prose'

export interface ReasoningPanelProps {
  readonly text: string
  readonly isStreaming: boolean
}

/** 印在行里的那一行：正在写就取最后一行，写完取第一行。 */
function tailLine(text: string, isStreaming: boolean): string {
  if (!isStreaming) {
    const head = text.indexOf('\n')

    return head === -1 ? text : text.slice(0, head)
  }

  const written = text.trimEnd()
  const last = written.lastIndexOf('\n')

  return last === -1 ? written : written.slice(last + 1)
}

/**
 * 思考链。
 *
 * 收起时是活动流里的一条记事：图标、"正在思考"、以及那一行随写随换的字 —— 思考是
 * 旁白，它不该在写的时候把答案顶下去。展开是同一段 markdown，由回答那条管线画。
 */
export function ReasoningPanel({ isStreaming, text }: ReasoningPanelProps) {
  const { isOpen, toggle } = useDisclosure(false)
  const { release, resume, stick, watch } = useFollowLatest()

  const line = tailLine(text, isStreaming)
  const lineRef = useRef<HTMLSpanElement | null>(null)

  /* 那一格只有一行，新到的字在右端：卷到末尾，字就从右边刷进来。 */
  // biome-ignore lint/correctness/useExhaustiveDependencies: line 是触发器不是读取值，删掉它流式期间就不会跟着写作边缘卷动
  useLayoutEffect(() => {
    const element = lineRef.current

    if (element === null) {
      return
    }

    element.scrollLeft = isStreaming ? element.scrollWidth - element.clientWidth : 0
  }, [isStreaming, line])

  /* 盒子的主人装订它自己的跟随；React 19 的 ref 回调交回卸载函数。 */
  const bindScroll = useCallback(
    (element: HTMLDivElement | null) => (element === null ? undefined : watch(element)),
    [watch],
  )

  const chasing = isOpen && isStreaming

  useLayoutEffect(() => {
    if (chasing) {
      resume()

      return
    }

    release()
  }, [chasing, release, resume])

  /* 文本长度就是这个盒子的水位线，渲染期已知，不必去读 scrollHeight。 */
  useLayoutEffect(() => {
    stick(text.length)
  }, [stick, text])

  return (
    <div className="timeline-reasoning" data-open={isOpen ? 'true' : undefined}>
      <button aria-expanded={isOpen} className="timeline-row" onClick={toggle} type="button">
        <ThinkingIcon aria-hidden="true" className="timeline-row__icon" />

        <span className="timeline-row__name">{isStreaming ? '正在思考' : '思考完毕'}</span>

        <span aria-hidden="true" className="timeline-row__dot" />

        <span
          className={cx('timeline-row__label', isStreaming && 'timeline-shimmer')}
          data-follow-end={isStreaming ? 'true' : undefined}
          ref={lineRef}
        >
          {line}
        </span>

        <ChevronDownIcon aria-hidden="true" className="timeline-row__chevron disclosure__chevron" />
      </button>

      <DisclosureBody isOpen={isOpen}>
        <div className="timeline-reasoning__scroll" ref={bindScroll}>
          <Prose className="timeline-reasoning__body" isStreaming={isStreaming} text={text} />
        </div>
      </DisclosureBody>
    </div>
  )
}
