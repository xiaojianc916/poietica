import './conversation-minimap.css'

import type { ConversationTurn } from '@poietica/agent'
import {
  type CSSProperties,
  memo,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { turnIndexAtRow } from '../threads/ordered-lookup'
import {
  MINIMAP_ACTIVE_OVERHANG,
  MINIMAP_SCROLL_PADDING,
  MINIMAP_TICK_LINE_HEIGHT,
  MINIMAP_TICK_PITCH,
  MINIMAP_TRACK_WIDTH,
  minimapTickTop,
  minimapTickWidth,
} from './conversation-minimap-geometry'

interface ConversationMinimapProps {
  readonly activeRow: number
  readonly hasEarlier: boolean
  readonly onSelect: (row: number) => void
  readonly turns: readonly ConversationTurn[]
}

interface Preview {
  readonly index: number
  readonly top: number
}

const INDEX_ATTRIBUTE = 'data-minimap-index'

function tickOf(target: EventTarget | null): HTMLButtonElement | null {
  return target instanceof Element
    ? target.closest<HTMLButtonElement>(`[${INDEX_ATTRIBUTE}]`)
    : null
}

function indexOf(tick: HTMLButtonElement | null): number {
  const value = Number(tick?.getAttribute(INDEX_ATTRIBUTE))
  return Number.isInteger(value) ? value : -1
}

const TickList = memo(function TickList({
  activeIndex,
  hasEarlier,
  pointerIndex,
  tabbableIndex,
  turns,
}: {
  readonly activeIndex: number
  readonly hasEarlier: boolean
  readonly pointerIndex: number
  readonly tabbableIndex: number
  readonly turns: readonly ConversationTurn[]
}) {
  return (
    <>
      {turns.map((turn, index) => {
        const title = turn.label.trim() || '未命名轮次'
        const position = hasEarlier
          ? `已载入第 ${index + 1} 轮`
          : `第 ${index + 1} 轮，共 ${turns.length} 轮`

        return (
          <li className="conversation-minimap__item" key={turn.id}>
            <button
              aria-current={index === activeIndex ? 'location' : undefined}
              aria-label={`${position}：${title}`}
              className="conversation-minimap__turn"
              data-minimap-index={index}
              tabIndex={index === tabbableIndex ? 0 : -1}
              type="button"
            >
              <span
                className="conversation-minimap__bar"
                style={{ width: minimapTickWidth(index, pointerIndex) }}
              />
            </button>
          </li>
        )
      })}
    </>
  )
})

function Rail({ activeRow, hasEarlier, onSelect, turns }: ConversationMinimapProps) {
  const activeIndex = turnIndexAtRow(turns, activeRow)
  const [pointerIndex, setPointerIndex] = useState(-1)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [tabbableIndex, setTabbableIndex] = useState(activeIndex)
  const [preview, setPreview] = useState<Preview | null>(null)
  const navRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setTabbableIndex((current) => Math.min(current, turns.length - 1))
  }, [turns.length])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null) {
      return
    }

    const centre =
      MINIMAP_SCROLL_PADDING + minimapTickTop(activeIndex) + MINIMAP_TICK_LINE_HEIGHT / 2
    const top = Math.max(0, centre - scroller.clientHeight / 2)
    scroller.scrollTo({ behavior: 'auto', top })
  }, [activeIndex])

  const showPreview = useCallback((index: number, tick: HTMLButtonElement) => {
    const nav = navRef.current
    if (nav === null) {
      return
    }

    const tickBox = tick.getBoundingClientRect()
    const navBox = nav.getBoundingClientRect()
    setPreview({ index, top: tickBox.top - navBox.top + tickBox.height / 2 })
  }, [])

  const focusTick = useCallback((index: number) => {
    const tick = listRef.current?.querySelector<HTMLButtonElement>(
      `[${INDEX_ATTRIBUTE}='${index}']`,
    )
    if (tick === undefined || tick === null) {
      return
    }
    setTabbableIndex(index)
    tick.focus()
  }, [])

  const handlePointerOver = useCallback(
    (event: ReactPointerEvent<HTMLOListElement>) => {
      if (event.pointerType === 'touch') {
        return
      }
      const tick = tickOf(event.target)
      const index = indexOf(tick)
      if (tick === null || index < 0) {
        return
      }
      setPointerIndex(index)
      if (focusedIndex < 0) {
        showPreview(index, tick)
      }
    },
    [focusedIndex, showPreview],
  )

  const handleFocus = useCallback(
    (event: ReactFocusEvent<HTMLOListElement>) => {
      const tick = tickOf(event.target)
      const index = indexOf(tick)
      if (tick === null || index < 0) {
        return
      }
      setFocusedIndex(index)
      setTabbableIndex(index)
      showPreview(index, tick)
    },
    [showPreview],
  )

  const handleBlur = useCallback((event: ReactFocusEvent<HTMLOListElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return
    }
    setFocusedIndex(-1)
    setPreview(null)
  }, [])

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLOListElement>) => {
      const index = indexOf(tickOf(event.target))
      const turn = turns[index]
      if (turn === undefined) {
        return
      }
      setTabbableIndex(index)
      onSelect(turn.rowIndex)
    },
    [onSelect, turns],
  )

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLOListElement>) => {
      const current = indexOf(tickOf(event.target))
      if (current < 0) {
        return
      }

      let next = current
      if (event.key === 'ArrowDown') {
        next = Math.min(turns.length - 1, current + 1)
      } else if (event.key === 'ArrowUp') {
        next = Math.max(0, current - 1)
      } else if (event.key === 'Home') {
        next = 0
      } else if (event.key === 'End') {
        next = turns.length - 1
      } else {
        return
      }

      event.preventDefault()
      focusTick(next)
    },
    [focusTick, turns.length],
  )

  const shownTurn = preview === null ? undefined : turns[preview.index]
  const shownTitle = shownTurn?.label.trim() || '未命名轮次'
  const activeWidth = minimapTickWidth(activeIndex, pointerIndex) + MINIMAP_ACTIVE_OVERHANG

  return (
    <nav
      aria-label="对话轮次导航"
      className="conversation-minimap"
      ref={navRef}
      style={
        {
          '--conversation-minimap-line': `${MINIMAP_TICK_LINE_HEIGHT}px`,
          '--conversation-minimap-padding': `${MINIMAP_SCROLL_PADDING}px`,
          '--conversation-minimap-pitch': `${MINIMAP_TICK_PITCH}px`,
          '--conversation-minimap-track': `${MINIMAP_TRACK_WIDTH}px`,
        } as CSSProperties
      }
    >
      <div
        className="conversation-minimap__scroller"
        onScroll={() => setPreview(null)}
        ref={scrollerRef}
      >
        <div
          className="conversation-minimap__track"
          style={{ blockSize: turns.length * MINIMAP_TICK_PITCH }}
        >
          <span
            aria-hidden="true"
            className="conversation-minimap__active"
            style={{
              transform: `translateY(${minimapTickTop(activeIndex)}px)`,
              width: activeWidth,
            }}
          />
          <ol
            className="conversation-minimap__list"
            onBlur={handleBlur}
            onClick={handleClick}
            onFocus={handleFocus}
            onKeyDown={handleKeyDown}
            onPointerLeave={() => {
              setPointerIndex(-1)
              if (focusedIndex < 0) {
                setPreview(null)
              }
            }}
            onPointerOver={handlePointerOver}
            ref={listRef}
          >
            <TickList
              activeIndex={activeIndex}
              hasEarlier={hasEarlier}
              pointerIndex={pointerIndex}
              tabbableIndex={tabbableIndex}
              turns={turns}
            />
          </ol>
        </div>
      </div>

      <div
        aria-hidden="true"
        className="conversation-minimap__card"
        data-shown={shownTurn === undefined ? undefined : ''}
        style={{ top: preview?.top ?? 0 }}
      >
        <p className="conversation-minimap__question">{shownTitle}</p>
        <p className="conversation-minimap__reply">{shownTurn?.reply?.trim() || '暂无文本回复'}</p>
      </div>
    </nav>
  )
}

export const ConversationMinimap = memo(function ConversationMinimap(
  props: ConversationMinimapProps,
) {
  return props.turns.length < 2 ? null : <Rail {...props} />
})
