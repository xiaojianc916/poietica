import { defaultRangeExtractor, type Range, useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { cn } from '../class-names'
import { FileTypeMark } from '../mark/file-type-mark'
import { treeKeyEffect } from './tree-keys'
import './file-tree.css'

/*
 * 文件树：审查的变更树与右坞「文件」面板共用的那一棵（原 review-pane.tsx 的 Tree / FolderRow /
 * FileRow 逐条照搬）。只认行模型与回调：行从哪来、点了文件做什么，都是消费方的事。文件图标用
 * FileTypeMark，目录只有开合箭头（那套图标里没有文件夹字形）。
 * 行是虚拟化的（@tanstack/react-virtual，与 DiffBody 同一个虚拟器）：展开几层大目录就是上万行，
 * 代价要随视口走。所以这棵树自己就是滚动口 —— 虚拟器要在挂载的同一次提交里拿到滚动元素，祖先的
 * ref 那时还没挂上（判例见 diff/surface.tsx）。行不全在 DOM 里，无障碍树靠 aria-level /
 * aria-setsize / aria-posinset 自报位置；漫游焦点那一行无论滚到哪都留着（rangeExtractor），
 * Tab 进出树都不会把焦点丢回 body。
 */

export interface FileTreeRow {
  readonly kind: 'file' | 'folder'
  /** 行的身份，同一棵树里唯一：文件是路径，目录是目录路径。 */
  readonly key: string
  readonly label: string
  readonly depth: number
  /** 只对目录有意义。 */
  readonly expanded?: boolean
  /** 被 .gitignore 忽略之类：字淡一档，仍可点开。 */
  readonly dimmed?: boolean
}

export interface FileTreeProps {
  readonly rows: readonly FileTreeRow[]
  /** 整棵树的无障碍名称。 */
  readonly label: string
  /** 选中的那一行（右坞正开着的文件）；不给则没有选中态。 */
  readonly selectedKey?: string | null
  readonly onToggle: (row: FileTreeRow) => void
  readonly onOpen: (row: FileTreeRow) => void
  /** 行尾的装饰（变更徽章等）。 */
  readonly trailing?: (row: FileTreeRow) => ReactNode
  /** 拖出去时放进 text/plain 的文字；返回 null 即这一行不可拖。 */
  readonly dragText?: (row: FileTreeRow) => string | null
  /**
   * 要滚到眼前的那一行（「在树中定位」、正文里点了一个目录）。它可能还不在 rows 里（祖先正在读）：等它出现再滚，
   * 滚到后回调 onRevealed，由消费方把请求清掉 —— 否则下次挂载又会滚一次。
   */
  readonly revealKey?: string | null
  readonly onRevealed?: (key: string) => void
  /** 加在滚动口上：消费方给尺寸（flex-1 / min-h-0）与内边距。 */
  readonly className?: string
}

/* 行高：与行的 h-7 同一个数。行高固定，虚拟器不必逐行量。 */
const ROW_PX = 28

/* 16px 一格；文件图标占掉箭头那一格，所以文件比同级目录少缩一格。 */
const INDENT = 16

function paddingStart(depth: number, folder: boolean): number {
  if (folder || depth === 0) {
    return 8 + depth * INDENT
  }
  return 8 + (depth - 1) * INDENT
}

function guideStart(index: number): number {
  return 8 + index * INDENT + 8
}

function Guides({ depth }: { readonly depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, index) => (
        <span
          aria-hidden
          className="file-tree__guide"
          key={guideStart(index)}
          style={{ insetInlineStart: `${String(guideStart(index))}px` }}
        />
      ))}
    </>
  )
}

function RowBody({ row, trailing }: { readonly row: FileTreeRow; readonly trailing: ReactNode }) {
  if (row.kind === 'folder') {
    return (
      <>
        {row.expanded === true ? (
          <ChevronDown aria-hidden className=" opacity-40" />
        ) : (
          <ChevronRight aria-hidden className=" opacity-40" />
        )}
        <span className="file-tree__label min-w-0 flex-1 truncate text-[13px] font-medium opacity-70">{row.label}</span>
        {trailing}
      </>
    )
  }
  return (
    <>
      {row.depth === 0 ? null : <span aria-hidden className="w-4 " />}
      <FileTypeMark name={row.key} />
      <span className="file-tree__label min-w-0 flex-1 truncate text-xs">{row.label}</span>
      {trailing}
    </>
  )
}

/*
 * 每一行在兄弟里的位置（aria-setsize / aria-posinset）：行是先序展开的，同一个父亲下的兄弟是同一深度的一段，
 * 中间只隔着更深的子孙。一遍扫过去，每一层开着的那一组记着成员，遇到更浅的行就把更深的组结账。
 */
interface SiblingPlace {
  readonly size: number
  readonly position: number
}

function siblingPlaces(rows: readonly FileTreeRow[]): readonly SiblingPlace[] {
  const sizes = new Array<number>(rows.length).fill(0)
  const positions = new Array<number>(rows.length).fill(0)
  const open: number[][] = []
  const settle = (group: readonly number[]): void => {
    for (const index of group) sizes[index] = group.length
  }
  rows.forEach((row, index) => {
    while (open.length > row.depth + 1) settle(open.pop() ?? [])
    while (open.length < row.depth + 1) open.push([])
    const group = open[row.depth] ?? []
    group.push(index)
    positions[index] = group.length
  })
  for (const group of open) settle(group)
  return rows.map((_, index) => ({ size: sizes[index] ?? 0, position: positions[index] ?? 0 }))
}

/* 焦点落在哪一行：上次按键挪到的那行还在就留着；不在了（被收起、被筛掉）退到选中行，再退到第一行。 */
function rovingKey(rows: readonly FileTreeRow[], focused: string | null, selected: string | null): string | null {
  if (focused !== null && rows.some((row) => row.key === focused)) {
    return focused
  }
  if (selected !== null && rows.some((row) => row.key === selected)) {
    return selected
  }
  return rows[0]?.key ?? null
}

export function FileTree({
  className,
  dragText,
  label,
  onOpen,
  onRevealed,
  onToggle,
  revealKey = null,
  rows,
  selectedKey = null,
  trailing,
}: FileTreeProps) {
  const [focused, setFocused] = useState<string | null>(null)
  const elements = useRef(new Map<string, HTMLElement>())
  /* 方向键挪到一行时它可能还没渲染：记下来，等它挂上再给焦点。 */
  const pendingFocus = useRef<string | null>(null)
  const viewport = useRef<HTMLDivElement | null>(null)
  const sizer = useRef<HTMLDivElement | null>(null)
  /* 滚动口自己的上内边距（消费方给的 py-1 之类）：列表从它下面开始，滚到某一行要把它算进去。内边距是消费方一次给定的，量一次。 */
  const [margin, setMargin] = useState(0)
  useLayoutEffect(() => {
    setMargin(sizer.current?.offsetTop ?? 0)
  }, [])
  const tabStop = rovingKey(rows, focused, selectedKey)
  const indexOf = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows])
  const places = useMemo(() => siblingPlaces(rows), [rows])
  const tabIndex = tabStop === null ? -1 : (indexOf.get(tabStop) ?? -1)

  const keep = useCallback(
    (range: Range): number[] => {
      const shown = defaultRangeExtractor(range)
      if (tabIndex < 0 || shown.includes(tabIndex)) return shown
      return [...shown, tabIndex].sort((a, b) => a - b)
    },
    [tabIndex],
  )
  /* 键函数换了虚拟器就重排全部行的位置：只随 rows 换，滚动引起的重渲不付这一份。 */
  const itemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows])
  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => ROW_PX,
    getItemKey: itemKey,
    getScrollElement: () => viewport.current,
    overscan: 12,
    rangeExtractor: keep,
    scrollMargin: margin,
  })

  const moveFocus = (key: string): void => {
    setFocused(key)
    const index = indexOf.get(key)
    if (index !== undefined) virtualizer.scrollToIndex(index, { align: 'auto' })
    const element = elements.current.get(key)
    if (element === undefined) {
      pendingFocus.current = key
      return
    }
    element.focus({ preventScroll: true })
  }

  useLayoutEffect(() => {
    const key = pendingFocus.current
    if (key === null) return
    const element = elements.current.get(key)
    if (element === undefined) return
    pendingFocus.current = null
    element.focus({ preventScroll: true })
  })

  useEffect(() => {
    if (revealKey === null) return
    const index = indexOf.get(revealKey)
    if (index === undefined) return
    setFocused(revealKey)
    virtualizer.scrollToIndex(index, { align: 'auto' })
    onRevealed?.(revealKey)
  }, [indexOf, onRevealed, revealKey, virtualizer])

  const activate = useCallback(
    (row: FileTreeRow) => {
      setFocused(row.key)
      if (row.kind === 'folder') onToggle(row)
      else onOpen(row)
    },
    [onOpen, onToggle],
  )

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, row: FileTreeRow): void => {
    const effect = treeKeyEffect(rows, row.key, event.key)
    if (effect.kind === 'none') return
    event.preventDefault()
    if (effect.kind === 'focus') {
      moveFocus(effect.key)
      return
    }
    const target = rows.find((held) => held.key === effect.key)
    if (target !== undefined) activate(target)
  }

  const onDragStart = (event: DragEvent<HTMLElement>, row: FileTreeRow): void => {
    const text = dragText?.(row) ?? null
    if (text === null) {
      event.preventDefault()
      return
    }
    event.dataTransfer.setData('text/plain', text)
    event.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div aria-label={label} className={cn('file-tree relative overflow-y-auto', className)} ref={viewport} role="tree">
      <div className="relative w-full" ref={sizer} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          if (row === undefined) return null
          const place = places[item.index]
          return (
            <div
              aria-expanded={row.kind === 'folder' ? row.expanded === true : undefined}
              aria-level={row.depth + 1}
              aria-posinset={place?.position}
              aria-selected={selectedKey === null ? undefined : row.key === selectedKey}
              aria-setsize={place?.size}
              className="file-tree__row absolute top-0 left-0 flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left"
              data-dimmed={row.dimmed === true ? '' : undefined}
              draggable={dragText !== undefined}
              key={item.key}
              onClick={() => {
                activate(row)
              }}
              onDragStart={(event) => {
                onDragStart(event, row)
              }}
              onKeyDown={(event) => {
                onKeyDown(event, row)
              }}
              ref={(element) => {
                if (element === null) return
                elements.current.set(row.key, element)
                return () => {
                  elements.current.delete(row.key)
                }
              }}
              role="treeitem"
              style={{
                paddingInlineStart: `${String(paddingStart(row.depth, row.kind === 'folder'))}px`,
                transform: `translateY(${String(item.start - margin)}px)`,
              }}
              tabIndex={row.key === tabStop ? 0 : -1}
            >
              <Guides depth={row.depth} />
              <RowBody row={row} trailing={trailing?.(row) ?? null} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
