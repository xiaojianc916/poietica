import './flow-row.css'
import './shimmer.css'
import './thought-card.css'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../primitives/class-names'
import { DisclosureBody } from '../primitives/disclosure'
import { ChevronDownIcon, ThinkingIcon } from '../primitives/icons'
import { useFollowEnd } from '../primitives/use-follow-end'
import { readThoughtLine } from '../semantics/thought-line'

/*
 * 滚动区与浮层宿主，契约在 agent-activity-feed 的类名上：viewport 是唯一滚动盒，
 * feed 自身不随滚动移动（position: relative），吸顶副本 portal 到它上面。
 */
const FEED_VIEWPORT = '.agent-activity-feed__viewport'
const FEED_HOST = '.agent-activity-feed'

/* rootMargin 把 root 收成视口顶边的一条横线：相交即「压着顶部线」。 */
const TOP_LINE_MARGIN = '0px 0px -100% 0px'

interface ThoughtHeadProps {
  readonly isOpen: boolean
  readonly isStreaming: boolean
  readonly line: string
  readonly name: string
  readonly onToggle: () => void
  /** 自然位那一份跟随末行横向滚动；吸顶副本不跟随（它只负责托住状态与开合）。 */
  readonly follow: boolean
  /** 只挂在自然位那一份上：吸顶观察要拿到这个元素。 */
  readonly headRef?: (node: HTMLElement | null) => void
}

/**
 * 推理头：一枚图标、一个名、一行原话，落定之后多一枚箭头。
 *
 * 自然位与吸顶副本是同一个组件，差别只有 follow 与 ref。
 */
function ThoughtHead({
  follow,
  headRef,
  isOpen,
  isStreaming,
  line,
  name,
  onToggle,
}: ThoughtHeadProps) {
  const label = useFollowEnd<HTMLSpanElement>(follow && isStreaming)

  const face = (
    <>
      <ThinkingIcon aria-hidden="true" className="timeline-row__icon" />

      <span className="timeline-row__name">{name}</span>

      <span aria-hidden="true" className="timeline-row__dot" />

      <span
        className={cx('timeline-row__label', isStreaming && 'timeline-shimmer')}
        data-follow-end={follow && isStreaming ? '' : undefined}
        ref={label}
      >
        {line}
      </span>
    </>
  )

  if (isStreaming) {
    return (
      <div className="timeline-row" data-measure="prose" ref={headRef}>
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
      ref={headRef}
      /* 副本不进 Tab 序：键盘滚动时浏览器把焦点所在的自然位按钮留在视口里。 */
      tabIndex={follow ? undefined : -1}
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
 * 长文滚动时头要一直在视口顶。虚拟行是 absolute + transform，行内 sticky 会被 transform
 * 钉死（见 thought-card.css），所以自然头滚过顶部线时，在不滚动的 feed 层 portal 一份
 * 几何对齐的副本；副本对读屏隐藏（aria-hidden），读屏与键盘只认自然位那一个头。
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

  const sectionRef = useRef<HTMLElement | null>(null)
  const [head, setHead] = useState<HTMLElement | null>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [dock, setDock] = useState<{ readonly left: number; readonly width: number } | null>(null)

  const bindSection = useCallback((node: HTMLElement | null) => {
    sectionRef.current = node
  }, [])

  /*
   * 吸顶判定：顶部线同时落在 section 内、又落在自然头之外 —— 头已经滚过视口顶，
   * 而这段推理还没滚完。流式时长高只改 section 底边，ResizeObserver 重判一次即可。
   */
  useEffect(() => {
    const section = sectionRef.current

    if (head === null || section === null) {
      return
    }

    const viewport = head.closest(FEED_VIEWPORT)
    const dockHost = head.closest(FEED_HOST)

    if (!(viewport instanceof HTMLElement) || !(dockHost instanceof HTMLElement)) {
      return
    }

    setHost(dockHost)

    let headCrossing = false
    let sectionCrossing = false
    let geometryKey = ''

    const measure = () => {
      const box = section.getBoundingClientRect()
      const hostBox = dockHost.getBoundingClientRect()

      return { left: box.left - hostBox.left, width: box.width }
    }

    const apply = () => {
      const next = sectionCrossing && !headCrossing ? measure() : null
      const key = next === null ? '' : `${String(next.left)}:${String(next.width)}`

      /* 几何没变就不提交：流式每帧长高，不该每帧重挂副本。 */
      if (key !== geometryKey) {
        geometryKey = key
        setDock(next)
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target === head) {
            headCrossing = entry.isIntersecting
          } else if (entry.target === section) {
            sectionCrossing = entry.isIntersecting
          }
        }

        apply()
      },
      { root: viewport, rootMargin: TOP_LINE_MARGIN, threshold: 0 },
    )

    observer.observe(head)
    observer.observe(section)

    const resized = new ResizeObserver(apply)
    resized.observe(section)

    return () => {
      observer.disconnect()
      resized.disconnect()
    }
  }, [head])

  return (
    <section className="timeline-tool" ref={bindSection}>
      <ThoughtHead
        follow
        headRef={setHead}
        isOpen={isOpen}
        isStreaming={isStreaming}
        line={line}
        name={name}
        onToggle={onToggle}
      />

      <DisclosureBody isOpen={isOpen}>
        <div className="timeline-thought">{text}</div>
      </DisclosureBody>

      {host !== null && dock !== null
        ? createPortal(
            <div
              aria-hidden="true"
              className="timeline-thought-dock"
              style={{ left: dock.left, width: dock.width }}
            >
              <ThoughtHead
                follow={false}
                isOpen={isOpen}
                isStreaming={isStreaming}
                line={line}
                name={name}
                onToggle={onToggle}
              />
            </div>,
            host,
          )
        : null}
    </section>
  )
}
