import type { GitChangeStatus } from '@poietica/contract/review'
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FileTypeMark,
  GithubMark,
  RegionSplitter,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@poietica/design-system'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  Copy,
  FileText,
  Folders,
  FoldVertical,
  GitCommitHorizontal,
  type LucideIcon,
  MoreHorizontal,
  Pilcrow,
  RefreshCw,
  Search,
  Type,
  UnfoldVertical,
  Upload,
  WrapText,
  X,
} from 'lucide-react'
import {
  type CSSProperties,
  Fragment,
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  type ChangeTreeFile,
  type ChangeTreeFolder,
  changeTreeRows,
  createReviewStore,
  type DiffFile,
  type DiffPiece,
  type DiffRow,
  type DiffStat,
  type ReviewDerive,
  type ReviewFailureReport,
  type ReviewGateway,
  type ReviewReading,
  type ReviewState,
  type ReviewStore,
  type ReviewSwitch,
  TREE_MAX,
  TREE_MIN,
  WORKTREE_BASE,
} from '../index'
import { createDeriver, type ReviewDeriver } from './derive'

import './review-pane.css'

type Ready = Extract<ReviewReading, { phase: 'ready' }>
const TROUBLE: Readonly<Record<'asking' | 'unreadable', string>> = {
  asking: '',
  unreadable: '读不到 git 变更。',
}
/* 列宽走注册过的自定义属性，与外壳那一份同构。 */
type ReviewStyle = CSSProperties & Record<`--${string}`, string>
/* 种类由行模型说，不由行首字符说：所以正文里不留 +/- 那一列。取色在 review-pane.css。 */
function toneOf(kind: DiffRow['kind']): string {
  if (kind === 'added') {
    return 'review-line review-line--added'
  }
  return kind === 'removed' ? 'review-line review-line--removed' : 'review-line'
}
const SWITCHES: readonly {
  readonly name: ReviewSwitch
  readonly icon: LucideIcon
  readonly on: string
  readonly off: string
}[] = [
  { icon: WrapText, name: 'wrap', off: '启用自动换行', on: '禁用自动换行' },
  { icon: Type, name: 'wordDiff', off: '启用文字差异', on: '禁用文字差异' },
  { icon: Pilcrow, name: 'hideWhitespace', off: '隐藏空白字符', on: '显示空白字符' },
]
const ICON_CLASS =
  'review-toolbar-action flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:opacity-100'
const ROW_CLASS = 'min-w-0 flex-1 truncate text-xs'
/* 菜单行的前导字形：与工具条上那枚同一档尺寸与不透明度。 */
const MENU_ICON_CLASS = 'size-3.5 shrink-0 opacity-60'
export interface ReviewPaneProps {
  readonly root: string
  readonly gateway: ReviewGateway
  readonly report: ReviewFailureReport
}

export function ReviewPane({ root, gateway, report }: ReviewPaneProps) {
  const holder = useRef<ReviewDeriver | null>(null)
  useEffect(() => {
    holder.current ??= createDeriver()
    return () => {
      holder.current?.dispose()
      holder.current = null
    }
  }, [])
  const derive = useCallback<ReviewDerive>((patch, wordDiff) => {
    if (holder.current === null) {
      holder.current = createDeriver()
    }
    return holder.current.derive(patch, wordDiff)
  }, [])
  const store = useMemo(
    () => createReviewStore({ root, derive, gateway, report }),
    [derive, gateway, report, root],
  )
  useEffect(() => store.start(), [store])
  const scroller = useRef<HTMLDivElement | null>(null)
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const reading = state.reading
  if (reading.phase === 'notARepository') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <FileText aria-hidden className="size-8 opacity-30" />
        <p className="text-sm font-medium">当前 workspace 不在 Git 仓库中</p>
        <p className="text-xs opacity-50">
          打开一个 Git 仓库目录后，这里会展示当前 workspace 作用域内的改动。
        </p>
      </div>
    )
  }
  if (reading.phase !== 'ready') {
    return <Note>{TROUBLE[reading.phase]}</Note>
  }
  const needle = state.query.trim().toLowerCase()
  const shown = reading.files.filter((file) => file.path.toLowerCase().includes(needle))
  const treeColumn = state.treeOpen && reading.files.length > 0 ? state.treeWidth : 0
  const style: ReviewStyle = { '--review-tree-width': `${String(treeColumn)}px` }
  return (
    <div
      className={cn(
        'review-pane flex h-full min-h-0 flex-col',
        state.splitter === 'idle' ? null : 'select-none',
      )}
      data-splitter={state.splitter}
      style={style}
    >
      <Toolbar reading={reading} state={state} store={store} />
      <div className="flex min-h-0 flex-1">
        <div className="review-scroll min-h-0 flex-1 overflow-y-auto" ref={scroller}>
          <Cards reading={reading} scroller={scroller} shown={shown} state={state} store={store} />
        </div>
        <Tree docked={treeColumn > 0} shown={shown} state={state} store={store} />
      </div>
    </div>
  )
}
function Cards({
  reading,
  scroller,
  shown,
  state,
  store,
}: {
  readonly reading: Ready
  readonly scroller: RefObject<HTMLDivElement | null>
  readonly shown: readonly DiffFile[]
  readonly state: ReviewState
  readonly store: ReviewStore
}) {
  if (reading.files.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
        <p className="text-sm font-medium">尚无文件变更</p>
        <p className="text-xs opacity-50">项目变更将显示在此处</p>
      </div>
    )
  }
  /* 筛选把主区筛空时也要说话：否则右边树在筛、左边一片空白没有理由。 */
  if (shown.length === 0) {
    return <Note>没有匹配的文件。</Note>
  }
  return (
    <>
      {shown.map((file) => (
        <Card file={file} key={file.path} scroller={scroller} state={state} store={store} />
      ))}
    </>
  )
}
/* 一条工具条：比较基准、总计、更多操作、折叠、文件树、提交 —— 基准入口只有一个。 */
function Toolbar({
  reading,
  state,
  store,
}: {
  readonly reading: Ready
  readonly state: ReviewState
  readonly store: ReviewStore
}) {
  const allOpen = reading.files.length > 0 && state.openFiles.size >= reading.files.length
  return (
    <div className="review-rule flex h-[var(--ui-control-height-sm)] shrink-0 items-center gap-2 px-2.5">
      <Bases base={state.base} reading={reading} store={store} />
      {/* 与卡头右侧那一处同档：整条工具条上只有这一对加减数，两处不一样大就是缺陷。 */}
      <Tally stat={reading.stat} />
      {reading.ahead + reading.behind > 0 ? (
        <span className="shrink-0 text-[11px] tabular-nums opacity-50">
          ↑{reading.ahead} ↓{reading.behind}
        </span>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <Overflow state={state} store={store} />
        <IconButton
          label={allOpen ? '折叠全部差异' : '展开全部差异'}
          onClick={() => {
            store.setAllOpen(!allOpen)
          }}
        >
          {allOpen ? (
            <FoldVertical aria-hidden className="size-4" />
          ) : (
            <UnfoldVertical aria-hidden className="size-4" />
          )}
        </IconButton>
        <IconButton label="变更文件树" onClick={store.toggleTree} pressed={state.treeOpen}>
          <Folders aria-hidden className="size-4" />
        </IconButton>
        <Commit reading={reading} state={state} store={store} />
      </div>
    </div>
  )
}
/*
 * 比较基准：一层菜单，档位、分组、选中打勾与不可用置灰都照 waku 的 diff 来源选择器
 * （src/app/right_panel.rs 的 right-panel-diff-source）。
 *
 * 六档先全部摆上：本仓现在只有「工作树对某个 ref」这一条路，落得下的只有未提交
 * （对 HEAD）与分支（对该分支的上游，没有上游就置灰）；其余四档要 git 侧先给出对应
 * 的范围，届时把它们接上即可 —— 所以这里只声明「哪一档对应哪个 ref」，ref 为 null
 * 即尚无实现，按 waku 对「上一轮」的做法置灰。
 */
function Bases({
  base,
  reading,
  store,
}: {
  readonly base: string
  readonly reading: Ready
  readonly store: ReviewStore
}) {
  const sources: readonly {
    readonly label: string
    readonly ref: string | null
    readonly separatorBefore?: boolean
  }[] = [
    { label: '上一轮', ref: null },
    { label: '未提交', ref: WORKTREE_BASE, separatorBefore: true },
    { label: '未暂存', ref: null },
    { label: '已暂存', ref: null },
    { label: '已提交', ref: null, separatorBefore: true },
    { label: '分支', ref: reading.upstream },
  ]
  const picked = sources.find((source) => source.ref !== null && source.ref === base)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="比较基准"
        className="review-toolbar-action flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-xs"
      >
        <span className="max-w-28 truncate">{picked?.label ?? '未提交'}</span>
        <ChevronDown aria-hidden className="size-2.5 shrink-0 opacity-40" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-40">
        {sources.map((source) => (
          <Fragment key={source.label}>
            {source.separatorBefore === true ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              disabled={source.ref === null}
              onClick={() => {
                if (source.ref !== null) {
                  store.setBase(source.ref)
                }
              }}
            >
              <span className={ROW_CLASS}>{source.label}</span>
              {source.ref !== null && source.ref === base ? (
                <Check aria-hidden className="size-3 shrink-0 opacity-60" />
              ) : null}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
function Overflow({ state, store }: { readonly state: ReviewState; readonly store: ReviewStore }) {
  const command = store.applyCommand()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="更多操作" className={ICON_CLASS}>
        <MoreHorizontal aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuItem onClick={store.refresh}>
          <RefreshCw aria-hidden className={MENU_ICON_CLASS} />
          <span className={ROW_CLASS}>刷新</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {SWITCHES.map((entry) => (
          <DropdownMenuItem
            key={entry.name}
            onClick={() => {
              store.toggleSwitch(entry.name)
            }}
          >
            <entry.icon aria-hidden className={MENU_ICON_CLASS} />
            <span className={ROW_CLASS}>
              {state.presentation[entry.name] ? entry.on : entry.off}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={command === ''}
          onClick={() => {
            /* 复制失败交给全局未处理拒绝那条策略，不在这里另开一套。 */
            void navigator.clipboard.writeText(command)
          }}
        >
          <Copy aria-hidden className={MENU_ICON_CLASS} />
          <span className={ROW_CLASS}>复制 git apply 命令</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
/* 提交、提交并推送、推送是三件事三条路：不再由一个动作替人决定要不要联网。 */
function Commit({
  reading,
  state,
  store,
}: {
  readonly reading: Ready
  readonly state: ReviewState
  readonly store: ReviewStore
}) {
  const canCommit =
    !state.busy && reading.files.length > 0 && (state.stageAll || reading.staged.size > 0)
  const canPush = !state.busy && (reading.ahead > 0 || reading.upstream === null)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="review-toolbar-action ml-1 flex h-6 shrink-0 items-center gap-1 rounded-md border border-current/15 px-2 text-xs disabled:opacity-50"
        disabled={state.busy}
      >
        <GithubMark className="opacity-60" />
        {state.busy ? '正在提交…' : '提交或推送'}
        <ChevronDown aria-hidden className="size-3 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="review-commit-menu w-80 rounded-2xl p-2">
        {/* 无缝输入：无边框，靠弹层自己垫底。 */}
        <textarea
          aria-label="提交信息"
          className="w-full resize-none bg-transparent px-3 py-2 text-xs outline-none placeholder:opacity-50"
          name="commit-message"
          onChange={(event) => {
            store.setDraft(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              if (canCommit) {
                store.commit('commit')
              }
              return
            }
            /* 菜单把方向键与字母当导航；说明框里它们是输入。 */
            if (event.key !== 'Escape' && event.key !== 'Tab') {
              event.stopPropagation()
            }
          }}
          placeholder="提交信息（留空将自动生成）…"
          rows={4}
          value={state.draft}
        />
        <label className="flex cursor-default items-center gap-2 px-3 py-2 text-xs">
          <input
            checked={state.stageAll}
            className="peer sr-only"
            onChange={(event) => {
              store.setStageAll(event.target.checked)
            }}
            type="checkbox"
          />
          <span
            aria-hidden
            className="grid size-4 shrink-0 place-items-center rounded-full border border-current/30 peer-focus-visible:ring-2 peer-focus-visible:ring-ring"
          >
            {state.stageAll ? <Check aria-hidden className="size-3" /> : null}
          </span>
          <span className="min-w-0 flex-1">包含未暂存的更改</span>
          <Tally dense stat={reading.unstaged} />
        </label>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="rounded-xl px-3"
          disabled={!canCommit}
          onClick={() => {
            store.commit('commit')
          }}
        >
          <GitCommitHorizontal aria-hidden className={MENU_ICON_CLASS} />
          <span className="min-w-0 flex-1 truncate text-xs">提交</span>
          <span className="review-commit-kbd">Ctrl+↵</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="rounded-xl px-3"
          disabled={!canCommit}
          onClick={() => {
            store.commit('commit-and-push')
          }}
        >
          <ArrowUp aria-hidden className={MENU_ICON_CLASS} />
          <span className="min-w-0 flex-1 truncate text-xs">提交并推送</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="rounded-xl px-3"
          disabled={!canPush}
          onClick={() => {
            store.commit('push')
          }}
        >
          <Upload aria-hidden className={MENU_ICON_CLASS} />
          <span className="min-w-0 flex-1 truncate text-xs">推送</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
function Card({
  file,
  scroller,
  state,
  store,
}: {
  readonly file: DiffFile
  readonly scroller: RefObject<HTMLDivElement | null>
  readonly state: ReviewState
  readonly store: ReviewStore
}) {
  const open = state.openFiles.has(file.path)
  /* 报一份估高：视口外的卡跳过绘制，没有估高滚动条会随视口推进跳动。
   * 行数按展开态算：折叠带展开的行也是这张卡此刻的真实高度。 */
  const rows = open ? renderedRowsOf(file, state.openGaps) : 0
  const style: ReviewStyle = { '--review-card-rows': String(rows) }
  return (
    <section className="review-card" id={cardId(file.path)} style={style}>
      {/* 两层：外面那条整宽且不透明，钉在滚动口上缘；里面的药丸给悬浮底色。
       * 底色不贴边、与树行同一条语言：margin 收出留白，padding 补回行内起点 ——
       * 比工具条那条 10px 内线再右挪 4px，文件名不贴着图标站。 */}
      <header className="review-card__head">
        <div className="review-card__head-row mx-1.5 flex h-7 items-center gap-2 rounded-md px-2">
          <button
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() => {
              store.toggleFile(file.path)
            }}
            type="button"
          >
            <FileTypeMark className="size-3.5 shrink-0" name={file.path} />
            <span className="review-card__path min-w-0 text-sm">
              <bdi>{file.path}</bdi>
            </span>
            <Tally stat={file.stat} />
          </button>
        </div>
      </header>
      {open ? <Body file={file} scroller={scroller} state={state} store={store} /> : null}
    </section>
  )
}

const VIRTUAL_AFTER = 500
/* 折叠带的身份：路径 + 它在行带里的位置。Gap、虚拟带与卡估高共用这一个产地。 */
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
function renderedRowsOf(file: DiffFile, openGaps: ReadonlySet<string>): number {
  let count = file.rows.length
  for (const row of file.rows) {
    if (row.kind === 'gap' && openGaps.has(gapKeyOf(file.path, row.at))) {
      count += row.hidden.length
    }
  }
  return count
}
function Body({
  file,
  scroller,
  state,
  store,
}: {
  readonly file: DiffFile
  readonly scroller: RefObject<HTMLDivElement | null>
  readonly state: ReviewState
  readonly store: ReviewStore
}) {
  if (file.binary) {
    return <Note>二进制文件，没有可对比的文本。</Note>
  }
  if (file.rows.length === 0) {
    return <Note>没有文本改动。</Note>
  }
  /* 不换行时这一格自己横滚：代码的缩进不能被折行改写。 */
  const wide = spanOf(file) > VIRTUAL_AFTER
  return (
    <div
      className={cn(
        'font-mono text-[12px] leading-5',
        state.presentation.wrap ? null : 'overflow-x-auto',
      )}
    >
      {wide ? (
        <VirtualRows file={file} scroller={scroller} state={state} store={store} />
      ) : (
        <Rows path={file.path} rows={file.rows} scroller={scroller} state={state} store={store} />
      )}
    </div>
  )
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
  readonly onClick?: () => void
}) {
  /* 悬浮药丸：无上下边框，左右留白不贴边，相邻两条之间由外层的 py 隔开。
   * 外层另带 review-gap-row：宽度取主区（见 review-pane.css），不跟最宽行走。 */
  return (
    <div className="review-gap-row px-2 py-1" ref={barRef}>
      <button
        className="review-gap flex w-full items-center gap-1.5 rounded-md px-2.5 py-0.5 text-left text-[10px] text-current/50 enabled:hover:text-current/90"
        disabled={onClick === undefined}
        onClick={onClick}
        type="button"
      >
        <Chevron aria-hidden className="size-3 shrink-0" />
        {label}
      </button>
    </div>
  )
}
/* 一串行：折叠带就地展开，展开出来的行与上下同在一条流里，列宽因此一致。 */
function Rows({
  path,
  rows,
  scroller,
  state,
  store,
}: {
  readonly path: string
  readonly rows: readonly DiffRow[]
  readonly scroller: RefObject<HTMLDivElement | null>
  readonly state: ReviewState
  readonly store: ReviewStore
}) {
  const wrap = state.presentation.wrap
  return (
    <div className={wrap ? undefined : 'w-max min-w-full'}>
      {rows.map((row, index) =>
        row.kind === 'gap' ? (
          <Gap
            edge={gapEdgeOf(index, rows.length)}
            key={row.at}
            path={path}
            row={row}
            scroller={scroller}
            state={state}
            store={store}
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
  path,
  row,
  scroller,
  state,
  store,
}: {
  readonly edge: GapEdge
  readonly path: string
  readonly row: DiffRow
  readonly scroller: RefObject<HTMLDivElement | null>
  readonly state: ReviewState
  readonly store: ReviewStore
}) {
  const key = gapKeyOf(path, row.at)
  const open = state.openGaps.has(key)
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
  const held = open
    ? row.hidden.map((heldRow) => (
        <Line key={heldRow.at} row={heldRow} wrap={state.presentation.wrap} />
      ))
    : null
  return (
    <>
      {edge === 'up' ? held : null}
      <GapBar
        barRef={barRef}
        chevron={gapChevronOf(edge)}
        label={open ? `折叠 ${label}` : label}
        {...(row.hidden.length === 0
          ? {}
          : {
              onClick: () => {
                anchor.current = barRef.current?.getBoundingClientRect().top ?? null
                store.toggleGap(key)
              },
            })}
      />
      {edge === 'up' ? null : held}
    </>
  )
}
/*
 * 大文件的行带虚拟化：只挂视口附近的行，代价随可见范围走、不随变更集走。
 * 折叠带展开的行也摊平成条目，展开一条万行折叠带不再是一次性挂万行 DOM。
 */
interface VirtualRowItem {
  readonly bar: boolean
  readonly edge: GapEdge
  readonly key: string
  readonly row: DiffRow
}
function spreadRows(
  rows: readonly DiffRow[],
  path: string,
  openGaps: ReadonlySet<string>,
): readonly VirtualRowItem[] {
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
  path,
  row,
  state,
  store,
}: {
  readonly edge: GapEdge
  readonly path: string
  readonly row: DiffRow
  readonly state: ReviewState
  readonly store: ReviewStore
}) {
  const key = gapKeyOf(path, row.at)
  const open = state.openGaps.has(key)
  const label = `${String(row.lines)} unmodified lines`
  return (
    <GapBar
      chevron={gapChevronOf(edge)}
      label={open ? `折叠 ${label}` : label}
      {...(row.hidden.length === 0 ? {} : { onClick: () => store.toggleGap(key) })}
    />
  )
}
function VirtualRows({
  file,
  scroller,
  state,
  store,
}: {
  readonly file: DiffFile
  readonly scroller: RefObject<HTMLDivElement | null>
  readonly state: ReviewState
  readonly store: ReviewStore
}) {
  const wrap = state.presentation.wrap
  const host = useRef<HTMLDivElement | null>(null)
  const items = useMemo(
    () => spreadRows(file.rows, file.path, state.openGaps),
    [file.path, file.rows, state.openGaps],
  )
  const widest = useMemo(() => widestOf(file.rows), [file.rows])
  /* 上方卡片的开合会挪这份列表的原点：渲染一次测一次，窗口变宽再补一次。 */
  const [origin, setOrigin] = useState(0)
  useLayoutEffect(() => {
    const hostEl = host.current
    const scrollEl = scroller.current
    if (hostEl === null || scrollEl === null) {
      return
    }
    const measure = (): void => {
      setOrigin(
        hostEl.getBoundingClientRect().top -
          scrollEl.getBoundingClientRect().top +
          scrollEl.scrollTop,
      )
    }
    measure()
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('resize', measure)
    }
  })
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
      className="review-rows--virtual"
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
              <VirtualGap
                edge={held.edge}
                path={file.path}
                row={held.row}
                state={state}
                store={store}
              />
            ) : (
              <Line row={held.row} wrap={wrap} />
            )}
          </div>
        )
      })}
    </div>
  )
}
/*
 * 单一行号槽 —— 统一视图里两列行号只有一列是答案。
 * 行号的字体、取色与右缘那道细线在 review-pane.css 的 .review-line__number；
 * self-stretch 让槽长满行高，折行的行上竖线才不在行中断开。
 * memo：行不变就不重渲 —— 筛选输入与分隔条拖动每帧都换快照，与行无关。
 */
const Line = memo(function Line({ row, wrap }: { readonly row: DiffRow; readonly wrap: boolean }) {
  return (
    <div className={cn('flex items-start pr-2.5', toneOf(row.kind))}>
      <span className="review-line__number w-11 shrink-0 self-stretch select-none pr-2 text-right">
        {row.number}
      </span>
      <span
        className={wrap ? 'min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'}
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
  const style: ReviewStyle | undefined =
    piece.color === null
      ? undefined
      : { '--review-syntax-dark': piece.color.dark, '--review-syntax-light': piece.color.light }
  const tone = cn(
    piece.color === null ? null : 'review-code',
    piece.emphasis ? 'review-line__emphasis' : null,
  )
  return (
    <span className={tone === '' ? undefined : tone} style={style}>
      {piece.text}
    </span>
  )
}
/* 右侧：变更文件树。筛选在顶，行按目录归并，左边缘拖着调宽。 */
function Tree({
  docked,
  shown,
  state,
  store,
}: {
  readonly docked: boolean
  readonly shown: readonly DiffFile[]
  readonly state: ReviewState
  readonly store: ReviewStore
}) {
  const rows = changeTreeRows(
    shown.map((file) => file.path),
    state.collapsedFolders,
  )
  /* 收起只是列宽归零：子树不卸载，滚动位置与展开状态不随开合重建。 */
  return (
    <aside className="review-tree" inert={!docked}>
      <div className="review-tree__clip">
        <div
          className="review-tree__surface flex flex-col"
          style={{ width: `${String(state.treeWidth)}px` }}
        >
          {/* 筛选是输入框而不是工具条：一条圆角药丸圈住图标与输入，与下面的树行
           * 分开读。左内边距 8 + 8 让放大镜落在树行图标的竖线上；右侧留 8px 给
           * 清除键 —— 再小它的方形悬浮底就顶出药丸的弧。 */}
          <div className="flex shrink-0 px-2 py-2">
            <div className="review-filter flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-full pr-2 pl-2.5">
              <Search aria-hidden className="size-3.5 shrink-0 text-placeholder" />
              <input
                aria-label="筛选文件"
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-placeholder"
                onChange={(event) => {
                  store.setQuery(event.target.value)
                }}
                placeholder="筛选文件…"
                value={state.query}
              />
              {/* 清除键常占位：有字没字行高等一边高，不跳。 */}
              <span className={state.query === '' ? 'invisible' : undefined}>
                <IconButton
                  label="清除筛选"
                  onClick={() => {
                    store.setQuery('')
                  }}
                >
                  <X aria-hidden className="size-3.5" />
                </IconButton>
              </span>
            </div>
          </div>
          <div className="review-tree__scroll min-h-0 flex-1 overflow-y-auto px-2 py-1">
            {rows.length === 0 ? (
              <Note>没有匹配的文件。</Note>
            ) : (
              rows.map((row) =>
                row.kind === 'folder' ? (
                  <FolderRow
                    collapsed={state.collapsedFolders.has(row.key)}
                    key={row.key}
                    row={row}
                    store={store}
                  />
                ) : (
                  <FileRow key={row.key} row={row} state={state} store={store} />
                ),
              )
            )}
          </div>
        </div>
      </div>
      {/* 指针捕获与键盘微调都在这条条上，本格不重写一套拖拽。 */}
      {docked ? (
        <RegionSplitter
          edge="inline-end"
          label="调整变更文件树宽度"
          max={TREE_MAX}
          min={TREE_MIN}
          onActivity={store.setSplitter}
          onCollapse={store.toggleTree}
          onResize={store.setTreeWidth}
          width={state.treeWidth}
        />
      ) : null}
    </aside>
  )
}
/* 树缩进照抄 OpenCode file-tree-v2（packages/app/src/components/file-tree-v2.tsx）：
 * 16px 一格；文件图标占掉箭头那一格，所以文件比同级目录少缩一格。 */
const TREE_INDENT = 16
function treePaddingStart(depth: number, folder: boolean): number {
  if (folder || depth === 0) {
    return 8 + depth * TREE_INDENT
  }
  return 8 + (depth - 1) * TREE_INDENT
}
/* 线落格中：与 file-tree-v2 的 guideLineStart 同式。 */
function treeGuideStart(index: number): number {
  return 8 + index * TREE_INDENT + 8
}
/* 引导线：与 file-tree-v2 的 GuideLines 同形 —— 绝对定位的 1px 竖线，
 * 上下各探 2px 过行缝；显形规则在 CSS（平时藏起，树悬浮才出现）。 */
function TreeGuides({ depth }: { readonly depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, index) => (
        <span
          aria-hidden
          className="tree-guide"
          key={treeGuideStart(index)}
          style={{ insetInlineStart: `${String(treeGuideStart(index))}px` }}
        />
      ))}
    </>
  )
}
function FolderRow({
  collapsed,
  row,
  store,
}: {
  readonly collapsed: boolean
  readonly row: ChangeTreeFolder
  readonly store: ReviewStore
}) {
  return (
    <button
      aria-expanded={!collapsed}
      className="review-tree-row relative flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left"
      onClick={() => {
        store.toggleFolder(row.key)
      }}
      style={{ paddingInlineStart: `${String(treePaddingStart(row.depth, true))}px` }}
      type="button"
    >
      <TreeGuides depth={row.depth} />
      {collapsed ? (
        <ChevronRight aria-hidden className="size-4 shrink-0 opacity-40" />
      ) : (
        <ChevronDown aria-hidden className="size-4 shrink-0 opacity-40" />
      )}
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium opacity-70">
        {row.label}
      </span>
    </button>
  )
}
function FileRow({
  row,
  state,
  store,
}: {
  readonly row: ChangeTreeFile
  readonly state: ReviewState
  readonly store: ReviewStore
}) {
  const status = state.reading.phase === 'ready' ? state.reading.statuses.get(row.path) : undefined
  return (
    <li
      className="review-tree-row relative flex h-7 items-center rounded-md pr-2"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', row.path)
        event.dataTransfer.effectAllowed = 'copy'
      }}
      style={{ paddingInlineStart: `${String(treePaddingStart(row.depth, false))}px` }}
    >
      <TreeGuides depth={row.depth} />
      <button
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        onClick={() => {
          const opening = !state.openFiles.has(row.path)
          store.toggleFile(row.path)
          if (opening) {
            document.getElementById(cardId(row.path))?.scrollIntoView({ block: 'start' })
          }
        }}
        type="button"
      >
        {row.depth === 0 ? null : <span aria-hidden className="w-4 shrink-0" />}
        <FileTypeMark className="size-3.5 shrink-0" name={row.label} />
        <span className="min-w-0 flex-1 truncate text-xs">{row.label}</span>
        {status === undefined ? null : <ChangeMark status={status} />}
      </button>
    </li>
  )
}
/* 树里点一行要能滚到对应的卡：id 由路径直接给，getElementById 不需要转义。 */
function cardId(path: string): string {
  return `review:${path}`
}
/* 一处变更的处境：新增是 U、删除是 D、改写是方框里一个点。
 * 只认 git 清单说的 status，不从加减行数反推：+0 −1 是删掉一行的改写，不是删文件。
 * U 与 D 是裸字母（不带框），颜色按处境分：新增绿、删除红、改写橙；色在 review-pane.css。
 * 目录不给徽章，目录不是 git 的变更单位。 */
const MARK_LABELS: Readonly<Record<GitChangeStatus, string>> = {
  added: '新增',
  conflicted: '冲突',
  deleted: '删除',
  modified: '修改',
  untracked: '未跟踪',
}
function ChangeMark({ status }: { readonly status: GitChangeStatus }) {
  const label = MARK_LABELS[status]
  return (
    <span
      aria-label={label}
      className="review-mark flex size-[13px] shrink-0 items-center justify-center rounded-[4px]"
      data-status={status}
      role="img"
      title={label}
    >
      {status === 'deleted' ? (
        /* 同 U：字面 D 而不是图标 —— git 清单里 D 就是删除。 */
        <span aria-hidden className="font-bold text-[13px] leading-none">
          D
        </span>
      ) : status === 'added' || status === 'untracked' ? (
        /* 字面 U 而不是图标：git 清单里 U 就是「未跟踪」，字形本身即记号。
         * U 与 D 这两支不加框（框在 CSS 里对它们收掉），所以字要自己够重。 */
        <span aria-hidden className="font-bold text-[13px] leading-none">
          U
        </span>
      ) : (
        <span aria-hidden className="size-[3px] rounded-full bg-current" />
      )}
    </span>
  )
}
function IconButton({
  children,
  label,
  onClick,
  pressed,
}: {
  readonly children: ReactNode
  readonly label: string
  readonly onClick: () => void
  readonly pressed?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        aria-pressed={pressed}
        className={ICON_CLASS}
        onClick={onClick}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
/* 两侧都写出来：删除专场也要看得见 +0，这是「数过了」与「没数」的区别。
 * 默认跟着卡头正文走；工具条与提交面板旁边是 11–12px 的字，那两处传 dense 收一档。 */
function Tally({
  dense = false,
  stat,
}: {
  /** 收一档。 */
  readonly dense?: boolean
  readonly stat: DiffStat
}) {
  if (stat.added === 0 && stat.removed === 0) {
    return null
  }
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1.5 tabular-nums',
        dense ? 'text-[11px]' : 'text-[13px]',
      )}
    >
      <span className="text-emerald-500">+{stat.added}</span>
      <span className="text-rose-500">−{stat.removed}</span>
    </span>
  )
}
function Note({ children }: { readonly children: ReactNode }) {
  return <p className="px-2.5 py-2 text-xs opacity-50">{children}</p>
}
