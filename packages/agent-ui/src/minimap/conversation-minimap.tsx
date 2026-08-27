import './conversation-minimap.css'
import type { ConversationTurn } from '@poietica/agent'
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
import { turnIndexAtRow } from '../threads/ordered-lookup'
import { RAIL_PITCH_PX, RAIL_VISIBLE_TURNS, railCentre } from './conversation-minimap-geometry'
import { useRailPointer } from './use-rail-pointer'

interface ConversationMinimapProps {
  readonly activeRow: number
  readonly hasEarlier: boolean
  readonly onSelect: (row: number) => void
  readonly turns: readonly ConversationTurn[]
}
const INDEX_ATTRIBUTE = 'data-minimap-index'
/** 事件落在哪一格上；落在轨道空白处答 -1。 */
function indexOf(target: EventTarget | null): number {
  const tick =
    target instanceof Element ? target.closest<HTMLElement>(`[${INDEX_ATTRIBUTE}]`) : null
  const value = tick?.getAttribute(INDEX_ATTRIBUTE)
  return value === undefined || value === null ? -1 : Number.parseInt(value, 10)
}
const TickList = memo(function TickList({
  activeIndex,
  hasEarlier,
  tabbable,
  turns,
}: {
  readonly activeIndex: number
  readonly hasEarlier: boolean
  readonly tabbable: number
  readonly turns: readonly ConversationTurn[]
}) {
  return (
    <>
      {turns.map((turn, index) => {
        const nth = `第 ${String(index + 1)} 轮`
        const where = hasEarlier ? `已载入${nth}` : `${nth}，共 ${String(turns.length)} 轮`
        return (
          <li className="conversation-minimap__item" key={turn.id}>
            <button
              aria-current={index === activeIndex ? 'location' : undefined}
              aria-label={`${where}：${turn.label.trim() || '未命名轮次'}`}
              className="conversation-minimap__turn"
              data-minimap-index={index}
              tabIndex={index === tabbable ? 0 : -1}
              type="button"
            >
              <span className="conversation-minimap__bar" />
            </button>
          </li>
        )
      })}
    </>
  )
})
function Rail({ activeRow, hasEarlier, onSelect, turns }: ConversationMinimapProps) {
  const activeIndex = turnIndexAtRow(turns, activeRow)
  const [shown, setShown] = useState(-1)
  const [tabbable, setTabbable] = useState(0)
  const listRef = useRef<HTMLOListElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const setRail = useRailPointer(setShown)
  useEffect(() => {
    setTabbable((current) => Math.min(current, Math.max(0, turns.length - 1)))
  }, [turns.length])
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
      const turn = turns[indexOf(event.target)]
      if (turn !== undefined) {
        onSelect(turn.rowIndex)
      }
    },
    [onSelect, turns],
  )
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLOListElement>) => {
      const current = indexOf(event.target)
      if (current < 0) {
        return
      }
      const last = turns.length - 1
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
    [turns.length],
  )
  const turn = turns[shown]
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
          <TickList
            activeIndex={activeIndex}
            hasEarlier={hasEarlier}
            tabbable={tabbable}
            turns={turns}
          />
        </ol>
      </div>
      <div
        aria-hidden="true"
        className="conversation-minimap__card"
        data-shown={turn === undefined ? undefined : ''}
      >
        <p className="conversation-minimap__card-question">{turn?.label.trim() || '未命名轮次'}</p>
        <p className="conversation-minimap__card-reply">{turn?.reply?.trim() || '暂无文本回复'}</p>
      </div>
    </nav>
  )
}
/* 一轮不成目录。 */
export const ConversationMinimap = memo(function ConversationMinimap(
  props: ConversationMinimapProps,
) {
  return props.turns.length < 2 ? null : <Rail {...props} />
})
