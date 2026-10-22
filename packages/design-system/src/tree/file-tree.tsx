import { ChevronDown, ChevronRight } from 'lucide-react'
import { type DragEvent, type KeyboardEvent, type ReactNode, useCallback, useRef, useState } from 'react'
import { cn } from '../class-names'
import { FileTypeMark } from '../mark/file-type-mark'
import { treeKeyEffect } from './tree-keys'
import './file-tree.css'

/*
 * 文件树：审查的变更树与右坞「文件」面板共用的那一棵（原 review-pane.tsx 的 Tree / FolderRow / FileRow，缩进、引导线、
 * 字号与图标逐条照搬）。它只认行模型与回调：行从哪来（变更清单 / 目录懒加载）、点了文件做什么，都是消费方的事。
 *
 * 文件图标用 FileTypeMark（项目内联的 Material Icon Theme），目录只有开合箭头 —— 那套图标里没有收文件夹字形，
 * 与审查树一直以来的样子一致。
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
  readonly className?: string
}

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
          <ChevronDown aria-hidden className="size-4 shrink-0 opacity-40" />
        ) : (
          <ChevronRight aria-hidden className="size-4 shrink-0 opacity-40" />
        )}
        <span className="file-tree__label min-w-0 flex-1 truncate text-[13px] font-medium opacity-70">{row.label}</span>
        {trailing}
      </>
    )
  }
  return (
    <>
      {row.depth === 0 ? null : <span aria-hidden className="w-4 shrink-0" />}
      <FileTypeMark className="size-3.5 shrink-0" name={row.key} />
      <span className="file-tree__label min-w-0 flex-1 truncate text-xs">{row.label}</span>
      {trailing}
    </>
  )
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
  onToggle,
  rows,
  selectedKey = null,
  trailing,
}: FileTreeProps) {
  const [focused, setFocused] = useState<string | null>(null)
  const elements = useRef(new Map<string, HTMLElement>())
  const tabStop = rovingKey(rows, focused, selectedKey)

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
      setFocused(effect.key)
      elements.current.get(effect.key)?.focus()
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
    <div aria-label={label} className={cn('file-tree flex flex-col', className)} role="tree">
      {rows.map((row) => (
        <div
          aria-expanded={row.kind === 'folder' ? row.expanded === true : undefined}
          aria-level={row.depth + 1}
          aria-selected={selectedKey === null ? undefined : row.key === selectedKey}
          className="file-tree__row relative flex h-7 w-full shrink-0 items-center gap-1.5 rounded-md pr-2 text-left"
          data-dimmed={row.dimmed === true ? '' : undefined}
          draggable={dragText !== undefined}
          key={row.key}
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
          style={{ paddingInlineStart: `${String(paddingStart(row.depth, row.kind === 'folder'))}px` }}
          tabIndex={row.key === tabStop ? 0 : -1}
        >
          <Guides depth={row.depth} />
          <RowBody row={row} trailing={trailing?.(row) ?? null} />
        </div>
      ))}
    </div>
  )
}
