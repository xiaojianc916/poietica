import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronsUpDown, ChevronUp, type LucideIcon } from 'lucide-react'
import { type CSSProperties, memo, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../class-names'
import type { DiffFile, DiffPiece, DiffRow } from './unified-diff'

import './surface.css'

/*
 * 一份 diff 的行带。
 *
 * 审查面板与工具抽屉画的是同一个模型（unified-diff.ts 的 DiffRow），所以行只有这一
 * 份实现：行号槽、增删底色、词级强调、折叠带、大文件的虚拟化。消费点只决定两件事
 * —— 横向出口归谁（scrollX），折叠带的开合状态归谁（openGaps 与 onToggleGap）。
 *
 * 行带的横向参照是滚动口的可视宽（折叠带要它才不跟着最宽行走）：谁交进 scroller，
 * 这里就自己量它、写进 --diff-row-inline-size，消费点不必再各装一次观察者。
 */

type RowStyle = CSSProperties & Record<`--${string}`, string>

/* 没有展开的折叠带。 */
const NO_GAPS: ReadonlySet<string> = new Set<string>()

/* 超过这么多行就虚拟化。 */
const VIRTUAL_AFTER = 500

/* 折叠带的身份：路径 + 它在行带里的位置。 */
function gapKeyOf(path: string, at: number): string {
  return `${path}#${String(at)}`
}

/* 潜在行幅：可见行加折叠带里可展开的那些 —— 判据与估高都从这一个数出发。 */
function spanOf(file: DiffFile): number {
  let span = file.rows.length

  for (const row of file.rows) {
    span += row.hidden.length
  }

  return span
}

/* 此刻要渲染的行数：展开的折叠带把 hidden 计入，收着的算一条。屏外卡的估高报它，
 * 直渲与虚拟化两条路的真值都与它对齐，滚动条不随视口推进跳动。 */
export function renderedRowsOf(file: DiffFile, openGaps: ReadonlySet<string>): number {
  let count = file.rows.length

  for (const row of file.rows) {
    if (row.kind === 'gap' && openGaps.has(gapKeyOf(file.path, row.at))) {
      count += row.hidden.length
    }
  }

  return count
}

/* 折叠带的展开方向：首条藏着上面的行，末条藏着下面的行，中间的双向。 */
type GapEdge = 'both' | 'down' | 'up'

function gapEdgeOf(index: number, length: number): GapEdge {
  if (length <= 1) {
    return 'both'
  }

  if (index === 0) {
    return 'up'
  }

  return index === length - 1 ? 'down' : 'both'
}

function gapChevronOf(edge: GapEdge): LucideIcon {
  return edge === 'up' ? ChevronUp : edge === 'down' ? ChevronDown : ChevronsUpDown
}

/* rows 为空的带子展不开：那些行确实没取回来，按下去也无可显示。 */
function GapBar({
  barRef,
  chevron: Chevron,
  label,
  onClick,
}: {
  readonly barRef?: RefObject<HTMLDivElement | null>
  readonly chevron: LucideIcon
  readonly label: string
  readonly onClick?: (() => void) | undefined
}) {
  /* 悬浮药丸：无上下边框，左右留白不贴边，相邻两条之间由外层的 py 隔开。
   * 外层另带 diff-gap-row：宽度取滚动口（见 surface.css），不跟最宽行走。 */
  return (
    <div className="diff-gap-row px-1.5 py-1" ref={barRef}>
      <button
        className="diff-gap flex h-7 w-full items-center gap-1.5 rounded-md px-2.5 text-left text-xs text-current/50 enabled:hover:text-current/90"
        disabled={onClick === undefined}
        onClick={onClick}
        type="button"
      >
        <Chevron aria-hidden className="size-3.5 shrink-0" />
        {label}
      </button>
    </div>
  )
}

/* 一串行：折叠带就地展开，展开出来的行与上下同在一条流里，列宽因此一致。 */
function Rows({
  file,
  onToggleGap,
  openGaps,
  scroller,
  wrap,
}: {
  readonly file: DiffFile
  readonly onToggleGap?: ((key: string) => void) | undefined
  readonly openGaps: ReadonlySet<string>
  readonly scroller: RefObject<HTMLDivElement | null>
  readonly wrap: boolean
}) {
  return (
    <div className={wrap ? undefined : 'w-max min-w-full'}>
      {file.rows.map((row, index) =>
        row.kind === 'gap' ? (
          <Gap
            edge={gapEdgeOf(index, file.rows.length)}
            file={file}
            key={row.at}
            onToggleGap={onToggleGap}
            openGaps={openGaps}
            row={row}
            scroller={scroller}
            wrap={wrap}
          />
        ) : (
          <Line key={row.at} row={row} wrap={wrap} />
        ),
      )}
    </div>
  )
}

/* 折叠带：补丁没带回来的行展不开，按钮就不给点。上面的行展开在条带上方，
 * 条带钉住不动：记住点按时条带的位置，画完把滚动差补回去，想看上面自己滑上去。 */
function Gap({
  edge,
  file,
  onToggleGap,
  openGaps,
  row,
  scroller,
  wrap,
}: {
  readonly edge: GapEdge
  readonly file: DiffFile
  readonly onToggleGap?: ((key: string) => void) | undefined
  readonly openGaps: ReadonlySet<string>
  readonly row: DiffRow
  readonly scroller: RefObject<HTMLDivElement | null>
  readonly wrap: boolean
}) {
  const key = gapKeyOf(file.path, row.at)
  const open = openGaps.has(key)
  const barRef = useRef<HTMLDivElement | null>(null)
  const anchor = useRef<number | null>(null)
  useLayoutEffect(() => {
    const bar = barRef.current
    const scrollEl = scroller.current
    if (anchor.current === null || bar === null || scrollEl === null) {
      return
    }
    scrollEl.scrollTop += bar.getBoundingClientRect().top - anchor.current
    anchor.current = null
  })
  const label = `${String(row.lines)} unmodified lines`
  const held = open ? row.hidden.map((heldRow) => <Line key={heldRow.at} row={heldRow} wrap={wrap} />) : null
  /* 补丁没带回来的行展不开（hidden 为空），抽屉里也没有开合状态（onToggleGap 缺席）：
   * 这两处都不给点，条子仍是条子，只是按不动。 */
  const toggle = onToggleGap

  return (
    <>
      {edge === 'up' ? held : null}
      <GapBar
        barRef={barRef}
        chevron={gapChevronOf(edge)}
        label={open ? `折叠 ${label}` : label}
        {...(row.hidden.length === 0 || toggle === undefined
          ? {}
          : {
              onClick: () => {
                anchor.current = barRef.current?.getBoundingClientRect().top ?? null
                toggle(key)
              },
            })}
      />
      {edge === 'up' ? null : held}
    </>
  )
}

/* 大文件的行带虚拟化：只挂视口附近的行，代价随可见范围走、不随变更集走；折叠带
 * 展开的行也摊平成条目，展开一条万行折叠带不再是一次性挂万行 DOM。 */
interface VirtualRowItem {
  readonly bar: boolean
  readonly edge: GapEdge
  readonly key: string
  readonly row: DiffRow
}

function spreadRows(rows: readonly DiffRow[], path: string, openGaps: ReadonlySet<string>): readonly VirtualRowItem[] {
  const items: VirtualRowItem[] = []

  rows.forEach((row, index) => {
    if (row.kind !== 'gap') {
      items.push({ bar: false, edge: 'both', key: gapKeyOf(path, row.at), row })
      return
    }

    const gapKey = gapKeyOf(path, row.at)

    items.push({ bar: true, edge: gapEdgeOf(index, rows.length), key: `${gapKey}#bar`, row })

    if (openGaps.has(gapKey)) {
      for (const held of row.hidden) {
        items.push({ bar: false, edge: 'both', key: `${gapKey}!${String(held.at)}`, row: held })
      }
    }
  })

  return items
}

/* 等宽字体里行宽只看字符数：不渲染也能算准横向滚动该给的宽度。 */
function widestOf(rows: readonly DiffRow[]): number {
  let width = 0

  for (const row of rows) {
    width = Math.max(width, row.text.length)

    for (const held of row.hidden) {
      width = Math.max(width, held.text.length)
    }
  }

  return width
}

/* 虚拟带里的折叠带：只画那一条带，展开的行是它下面的独立条目；
 * 条目绝对定位，条带自己的偏移开展前后不变，所以天然钉在原地。 */
function VirtualGap({
  edge,
  file,
  onToggleGap,
  openGaps,
  row,
}: {
  readonly edge: GapEdge
  readonly file: DiffFile
  readonly onToggleGap?: ((key: string) => void) | undefined
  readonly openGaps: ReadonlySet<string>
  readonly row: DiffRow
}) {
  const key = gapKeyOf(file.path, row.at)
  const open = openGaps.has(key)
  const label = `${String(row.lines)} unmodified lines`
  const toggle = onToggleGap

  return (
    <GapBar
      chevron={gapChevronOf(edge)}
      label={open ? `折叠 ${label}` : label}
      {...(row.hidden.length === 0 || toggle === undefined ? {} : { onClick: () => toggle(key) })}
    />
  )
}

/* 列表相对滚动内容的原点：上方内容的开合与滚动口自身的盒子，最后都只落在这一个数上。 */
function originOf(hostEl: HTMLElement, scrollEl: HTMLElement): number {
  return hostEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
}

function VirtualRows({
  file,
  onToggleGap,
  openGaps,
  scroller,
  wrap,
}: {
  readonly file: DiffFile
  readonly onToggleGap?: ((key: string) => void) | undefined
  readonly openGaps: ReadonlySet<string>
  readonly scroller: RefObject<HTMLDivElement | null>
  readonly wrap: boolean
}) {
  const host = useRef<HTMLDivElement | null>(null)
  const items = useMemo(() => spreadRows(file.rows, file.path, openGaps), [file.path, file.rows, openGaps])
  const widest = useMemo(() => widestOf(file.rows), [file.rows])
  /*
   * 这份列表的原点，两个触发源各走各的路：上方内容的开合改的是布局（items 换了
   * 就是它），量一次比观察谁都准，每次提交后重量一次；面板拖宽改的是滚动口自己的
   * 盒子，那条路上浏览器不发 resize（见 packages/browser/src/viewport-alignment.ts），
   * 观察滚动口与列表本身接住它，观察者只装卸一次。
   */
  const [origin, setOrigin] = useState(0)
  useLayoutEffect(() => {
    const hostEl = host.current
    const scrollEl = scroller.current
    if (hostEl === null || scrollEl === null) {
      return
    }
    setOrigin(originOf(hostEl, scrollEl))
  })
  useLayoutEffect(() => {
    const hostEl = host.current
    const scrollEl = scroller.current
    if (hostEl === null || scrollEl === null) {
      return
    }
    const observer = new ResizeObserver(() => {
      setOrigin(originOf(hostEl, scrollEl))
    })
    observer.observe(scrollEl)
    observer.observe(hostEl)
    return () => {
      observer.disconnect()
    }
  }, [scroller])
  const virtualizer = useVirtualizer({
    count: items.length,
    estimateSize: () => 20,
    getScrollElement: () => scroller.current,
    getItemKey: (index: number) => items[index]?.key ?? index,
    overscan: 12,
    scrollMargin: origin,
  })

  return (
    <div
      className="diff-body__virtual"
      ref={host}
      style={{
        height: virtualizer.getTotalSize(),
        ...(wrap ? {} : { minWidth: `calc(${String(widest)}ch + 3.375rem)` }),
      }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const held = items[item.index]

        if (held === undefined) {
          return null
        }

        return (
          <div
            className="absolute inset-x-0 top-0"
            data-index={item.index}
            key={item.key}
            ref={virtualizer.measureElement}
            style={{ transform: `translateY(${String(item.start - origin)}px)` }}
          >
            {held.bar ? (
              <VirtualGap edge={held.edge} file={file} onToggleGap={onToggleGap} openGaps={openGaps} row={held.row} />
            ) : (
              <Line row={held.row} wrap={wrap} />
            )}
          </div>
        )
      })}
    </div>
  )
}

/* 种类由行模型说，不由行首字符说：所以正文里不留 +/- 那一列。取色在 surface.css。 */
function toneOf(kind: DiffRow['kind']): string {
  if (kind === 'added') {
    return 'diff-line diff-line--added'
  }

  return kind === 'removed' ? 'diff-line diff-line--removed' : 'diff-line'
}

/*
 * 单一行号槽 —— 统一视图里两列行号只有一列是答案。字体、取色与右缘细线在
 * surface.css 的 .diff-line__number；self-stretch 让槽长满行高，折行的行上
 * 竖线才不在行中断开。memo：筛选输入与分隔条拖动每帧都换快照，行不变就不重渲。
 */
const Line = memo(function Line({ row, wrap }: { readonly row: DiffRow; readonly wrap: boolean }) {
  return (
    <div className={cn('flex items-start pr-2.5', toneOf(row.kind))}>
      <span className="diff-line__number w-11 shrink-0 self-stretch select-none pr-2 text-right">{row.number}</span>
      <span
        className={cn(
          'diff-line__code',
          wrap ? 'min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre',
        )}
      >
        {row.pieces.map((piece) => (
          <Piece key={piece.at} piece={piece} />
        ))}
      </span>
    </div>
  )
})

/* 一段正文：颜色来自语法着色，底色来自词级差异，两者可以落在同一段上。 */
function Piece({ piece }: { readonly piece: DiffPiece }) {
  const style: RowStyle | undefined =
    piece.color === null
      ? undefined
      : { '--diff-syntax-dark': piece.color.dark, '--diff-syntax-light': piece.color.light }
  const tone = cn(piece.color === null ? null : 'diff-code', piece.emphasis ? 'diff-line__emphasis' : null)

  return (
    <span className={tone === '' ? undefined : tone} style={style}>
      {piece.text}
    </span>
  )
}

/**
 * 一处改动的行带。
 *
 * 折叠带的身份是「路径 + 行在带里的位置」，键由这里发；消费点只把交回来的那个键
 * 记进自己的开合集合，不必知道它怎么拼。两处消费点各要各的：审查面板要开合（openGaps
 * 与 onToggleGap），工具抽屉既不开合、也不要那条带子（gaps={false}，理由见下）。
 */
export function DiffBody({
  file,
  gaps = true,
  onToggleGap,
  openGaps = NO_GAPS,
  scroller,
  scrollX = true,
  wrap,
}: {
  readonly file: DiffFile
  /**
   * 画不画折叠带。
   *
   * 折叠带说的是「这里跳过了一段没改动的行」，它有意义的前提是那些行确实存在而没画。
   * 工具抽屉画的是一对正文（file-diff.ts 的 computeFile，只取三行上下文），跳过的行
   * 从来没进过这一份模型 —— 那条带子就只是在两行中间插一句谁也不需要的话，所以关掉。
   */
  readonly gaps?: boolean
  readonly onToggleGap?: ((key: string) => void) | undefined
  readonly openGaps?: ReadonlySet<string>
  readonly scroller: RefObject<HTMLDivElement | null>
  /**
   * 横向出口在不在这里。
   *
   * 审查面板的滚动口只滚纵向（review-pane.tsx 那个 .review-scroll），行带自己横滚；
   * 抽屉里 diff 本身就是那个双轴滚动容器（tool-call.css 的 __diff），行带再开一个
   * 就是屏幕上第二条横条。
   */
  readonly scrollX?: boolean
  readonly wrap: boolean
}) {
  /* 不画折叠带时先把它们摘掉：条子、虚拟化条目与行幅都从这同一份出发。 */
  const shown = useMemo(
    () => (gaps ? file : { ...file, rows: file.rows.filter((row) => row.kind !== 'gap') }),
    [file, gaps],
  )
  /* 不换行时这一格自己横滚：代码的缩进不能被折行改写。 */
  const wide = spanOf(shown) > VIRTUAL_AFTER
  const host = useRef<HTMLDivElement | null>(null)

  /*
   * 折叠带的宽度锚是滚动口的可视宽，不是行带自己的宽（它是 max-content）。
   *
   * cqw 在真实 DOM 里会被降级/覆盖成内容宽，所以只能量。锚挂在这里而不是各消费点：
   * 谁交进 scroller，谁就自动拿到正确的折叠带宽度，不必再各自装一次观察者。
   *
   * 用 effect 而不是 layout effect：滚动口是这一层的祖先，祖先的 ref 在整棵树提交完
   * 才挂上，layout 阶段读它必然是 null（判例见 virtual-lines.tsx 头注释）。
   * 不画折叠带时没有人读这个变量，观察者也不必装。
   */
  useEffect(() => {
    const el = scroller.current
    const own = host.current

    if (!gaps || el === null || own === null) {
      return
    }

    const measure = () => {
      own.style.setProperty('--diff-row-inline-size', `${String(el.clientWidth)}px`)
    }

    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(el)

    return () => {
      observer.disconnect()
    }
  }, [gaps, scroller])

  return (
    <div className={cn('diff-body', scrollX && !wrap ? 'overflow-x-auto' : null)} ref={host}>
      {wide ? (
        <VirtualRows file={shown} onToggleGap={onToggleGap} openGaps={openGaps} scroller={scroller} wrap={wrap} />
      ) : (
        <Rows file={shown} onToggleGap={onToggleGap} openGaps={openGaps} scroller={scroller} wrap={wrap} />
      )}
    </div>
  )
}
