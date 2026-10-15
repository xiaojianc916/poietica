import './conversation-minimap.css'
import {
  type CSSProperties,
  memo,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { TurnMark } from '../../agent/thread'
import { RAIL_PITCH_PX, RAIL_VISIBLE_TURNS, railCentre } from './conversation-minimap-geometry'
import { useRailPointer } from './use-rail-pointer'

/* 一格一轮，定义域是帧日志（transcript 的 outline）而不是此刻载入了多少，所以轨道长度不随滚动
 * 伸缩；地址用 admissionId —— 行号会随回填改变，号不会。 */
interface ConversationMinimapProps {
  readonly activeId: string | undefined
  readonly busyId: string | null
  readonly marks: readonly TurnMark[]
  readonly onSelect: (mark: TurnMark) => void
}
const INDEX_ATTRIBUTE = 'data-minimap-index'
const UNNAMED = '未命名轮次'
const NO_REPLY = '暂无文本回复'
/** 事件落在哪一格上；落在轨道空白处答 -1。 */
function indexOf(target: EventTarget | null): number {
  const tick = target instanceof Element ? target.closest<HTMLElement>(`[${INDEX_ATTRIBUTE}]`) : null
  const value = tick?.getAttribute(INDEX_ATTRIBUTE)
  return value === undefined || value === null ? -1 : Number.parseInt(value, 10)
}
const TickList = memo(function TickList({
  activeIndex,
  busyId,
  marks,
  tabbable,
}: {
  readonly activeIndex: number
  readonly busyId: string | null
  readonly marks: readonly TurnMark[]
  readonly tabbable: number
}) {
  return (
    <>
      {marks.map((mark, index) => (
        <li className="conversation-minimap__item" key={mark.admissionId}>
          <button
            aria-busy={mark.admissionId === busyId || undefined}
            aria-current={index === activeIndex ? 'location' : undefined}
            aria-label={`第 ${String(index + 1)} 轮，共 ${String(marks.length)} 轮：${mark.prompt.trim() || UNNAMED}`}
            className="conversation-minimap__turn"
            data-busy={mark.admissionId === busyId ? '' : undefined}
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
function PreviewCard({ mark }: { readonly mark: TurnMark | undefined }) {
  const [retained, setRetained] = useState(mark)
  /* 隐藏只撤掉 data-shown：退出延迟和淡出期间仍能看见正文，不能换成空轮次的占位文案。
   * 留住最后一次有效快照，而不是下标；轮次回填或移除也不能改写正在退场的内容。 */
  if (mark !== undefined && mark !== retained) {
    setRetained(mark)
  }
  const preview = mark ?? retained
  return (
    <div aria-hidden="true" className="conversation-minimap__card" data-shown={mark === undefined ? undefined : ''}>
      {preview !== undefined && (
        <>
          <p className="conversation-minimap__card-question">{preview.prompt.trim() || UNNAMED}</p>
          <p className="conversation-minimap__card-reply">{preview.reply?.trim() || NO_REPLY}</p>
        </>
      )}
    </div>
  )
}
function Rail({ activeId, busyId, marks, onSelect }: ConversationMinimapProps) {
  const activeIndex = useMemo(
    () =>
      Math.max(
        0,
        marks.findIndex((mark) => mark.admissionId === activeId),
      ),
    [activeId, marks],
  )
  const [shown, setShown] = useState(-1)
  const [tabbable, setTabbable] = useState(0)
  const listRef = useRef<HTMLOListElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const setRail = useRailPointer(setShown)
  useEffect(() => {
    setTabbable((current) => Math.min(current, Math.max(0, marks.length - 1)))
  }, [marks.length])
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
      listRef.current?.querySelector<HTMLButtonElement>(`[${INDEX_ATTRIBUTE}='${String(next)}']`)?.focus()
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
          <TickList activeIndex={activeIndex} busyId={busyId} marks={marks} tabbable={tabbable} />
        </ol>
      </div>
      <PreviewCard mark={mark} />
    </nav>
  )
}
/* 一轮不成目录。 */
export const ConversationMinimap = memo(function ConversationMinimap(props: ConversationMinimapProps) {
  return props.marks.length < 2 ? null : <Rail {...props} />
})
