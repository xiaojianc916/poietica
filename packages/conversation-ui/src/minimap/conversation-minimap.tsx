import './conversation-minimap.css'
import type { TurnMark } from '@poietica/agent-contract'
import {
  type CSSProperties,
  memo,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { RAIL_PITCH_PX, RAIL_VISIBLE_TURNS, railCentre } from './conversation-minimap-geometry'
import { useRailPointer } from './use-rail-pointer'

/*
 * 对话目录。
 *
 * 一格一轮，定义域是帧日志（transcript 的 outline），不是此刻载入了多少 —— 所以
 * 轨道长度不随滚动伸缩，第一轮从头到尾都点得到。地址是 admissionId：行号会随回填
 * 改变，号不会。
 */
interface ConversationMinimapProps {
  /** 正在读的那一轮，按 id。 */
  readonly activeId: string | undefined
  readonly marks: readonly TurnMark[]
  readonly onSelect: (mark: TurnMark) => void
}
const INDEX_ATTRIBUTE = 'data-minimap-index'
const UNNAMED = '未命名轮次'
/** 事件落在哪一格上；落在轨道空白处答 -1。 */
function indexOf(target: EventTarget | null): number {
  const tick =
    target instanceof Element ? target.closest<HTMLElement>(`[${INDEX_ATTRIBUTE}]`) : null
  const value = tick?.getAttribute(INDEX_ATTRIBUTE)
  return value === undefined || value === null ? -1 : Number.parseInt(value, 10)
}
const TickList = memo(function TickList({
  activeIndex,
  marks,
  tabbable,
}: {
  readonly activeIndex: number
  readonly marks: readonly TurnMark[]
  readonly tabbable: number
}) {
  return (
    <>
      {marks.map((mark, index) => (
        <li className="conversation-minimap__item" key={mark.admissionId}>
          <button
            aria-current={index === activeIndex ? 'location' : undefined}
            aria-label={`第 ${String(index + 1)} 轮，共 ${String(marks.length)} 轮：${
              mark.prompt.trim() || UNNAMED
            }`}
            className="conversation-minimap__turn"
            data-minimap-index={index}
            tabIndex={index === tabbable ? 0 : -1}
            type="button"
          >
            <span className="conversation-minimap__bar" />
          </button>
        </li>
      ))}
    </>
  )
})
function Rail({ activeId, marks, onSelect }: ConversationMinimapProps) {
  const activeIndex = Math.max(
    0,
    marks.findIndex((mark) => mark.admissionId === activeId),
  )
  const [shown, setShown] = useState(-1)
  const [tabbable, setTabbable] = useState(0)
  const listRef = useRef<HTMLOListElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const setRail = useRailPointer(setShown)
  useEffect(() => {
    setTabbable((current) => Math.min(current, Math.max(0, marks.length - 1)))
  }, [marks.length])
  /* 读到哪一轮，轨道就把那一格滚到中间。 */
  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null) {
      return
    }
    scroller.scrollTo({
      behavior: 'auto',
      top: Math.max(0, railCentre(activeIndex) - scroller.clientHeight / 2),
    })
  }, [activeIndex])
  const handleFocus = useCallback((event: ReactFocusEvent<HTMLOListElement>) => {
    const index = indexOf(event.target)
    if (index >= 0) {
      setTabbable(index)
    }
  }, [])
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLOListElement>) => {
      const mark = marks[indexOf(event.target)]
      if (mark !== undefined) {
        onSelect(mark)
      }
    },
    [marks, onSelect],
  )
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLOListElement>) => {
      const current = indexOf(event.target)
      if (current < 0) {
        return
      }
      const last = marks.length - 1
      let next = current
      if (event.key === 'ArrowDown') {
        next = Math.min(last, current + 1)
      } else if (event.key === 'ArrowUp') {
        next = Math.max(0, current - 1)
      } else if (event.key === 'Home') {
        next = 0
      } else if (event.key === 'End') {
        next = last
      } else {
        return
      }
      event.preventDefault()
      listRef.current
        ?.querySelector<HTMLButtonElement>(`[${INDEX_ATTRIBUTE}='${String(next)}']`)
        ?.focus()
    },
    [marks.length],
  )
  const mark = marks[shown]
  return (
    <nav
      aria-label="对话轮次导航"
      className="conversation-minimap"
      ref={setRail}
      style={
        {
          '--cp-rail-hit': `${String(RAIL_PITCH_PX)}px`,
          '--cp-rail-visible': String(RAIL_VISIBLE_TURNS),
        } as CSSProperties
      }
    >
      <div className="conversation-minimap__scroller" ref={scrollerRef}>
        <ol
          className="conversation-minimap__list"
          onClick={handleClick}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
          ref={listRef}
        >
          <TickList activeIndex={activeIndex} marks={marks} tabbable={tabbable} />
        </ol>
      </div>
      <div
        aria-hidden="true"
        className="conversation-minimap__card"
        data-shown={mark === undefined ? undefined : ''}
      >
        <p className="conversation-minimap__card-question">{mark?.prompt.trim() || UNNAMED}</p>
        <p className="conversation-minimap__card-reply">{mark?.reply?.trim() || '暂无文本回复'}</p>
      </div>
    </nav>
  )
}
/* 一轮不成目录。 */
export const ConversationMinimap = memo(function ConversationMinimap(
  props: ConversationMinimapProps,
) {
  return props.marks.length < 2 ? null : <Rail {...props} />
})
