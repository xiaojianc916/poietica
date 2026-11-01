import {
  cn,
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FileTree,
  type FileTreeRow,
  FileTypeMark,
  GithubMark,
  pathTreeRows,
  RegionSplitter,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@poietica/design-system'
import type { DiffFile, DiffStat } from '@poietica/design-system/diff'
import { DiffBody, renderedRowsOf } from '@poietica/design-system/diff/surface'
import { useFeatureStore } from '@poietica/ui-kernel'
import {
  ArrowUp,
  Check,
  ChevronDown,
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
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { FileChange } from '../contract'
import {
  type ReviewFailureReport,
  type ReviewGateway,
  type ReviewReading,
  type ReviewState,
  type ReviewStore,
  type ReviewSwitch,
  TREE_MAX,
  TREE_MIN,
  WORKTREE_BASE,
} from './review-store'
import { useReviewStore } from './review-store-holder'

import './review-pane.css'

type Ready = Extract<ReviewReading, { phase: 'ready' }>
const TROUBLE: Readonly<Record<'asking' | 'unreadable', string>> = {
  asking: '',
  unreadable: '读不到 git 变更。',
}
type ReviewStyle = CSSProperties & Record<`--${string}`, string>
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
const ROW_CLASS = 'min-w-0 flex-1 truncate'
export interface ReviewPaneProps {
  readonly gateway: ReviewGateway
  readonly report: ReviewFailureReport
}

export function ReviewPane({ gateway, report }: ReviewPaneProps) {
  /* store 按工作区共享：「Git 工具」那一格读的是**同一个对象**，所以工具条、那一格与分支名永远是同一份快照。 */
  const store = useReviewStore(gateway, report)
  const scroller = useRef<HTMLDivElement | null>(null)
  const state = useFeatureStore(store.store, (held) => held)
  const reading = state.reading
  /* 覆盖式滚动条的滑块几何：跟着滚动容器的滚动量走。 */
  const thumb = useOverlayScrollbar(scroller)
  if (reading.phase === 'notARepository') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <FileText aria-hidden className=" opacity-30" />
        <p className="text-sm font-medium">当前 workspace 不在 Git 仓库中</p>
        <p className="text-xs opacity-50">打开一个 Git 仓库目录后，这里会展示当前 workspace 作用域内的改动。</p>
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
      /* 只有拖拽中关掉划选：分隔条那 8px 命中区跨在列边界上，指针停在那里是正常的。 */
      className={cn('review-pane flex h-full min-h-0 flex-col', state.splitter === 'drag' ? 'select-none' : null)}
      data-splitter={state.splitter}
      style={style}
    >
      <Toolbar reading={reading} state={state} store={store} />
      <div className="flex min-h-0 flex-1">
        {/* 滚动条画在里面、盖在内容上：把它画在滚动体外面就要占一列宽度，变更区会跟着变窄。
            这层只管给那条绝对定位的滑块当锚，不接任何悬停反馈。 */}
        <div className="relative min-h-0 flex-1">
          <div className="review-scroll h-full min-h-0 overflow-y-auto" ref={scroller}>
            <Cards reading={reading} scroller={scroller} shown={shown} state={state} store={store} />
          </div>
          <OverlayScrollbar scroller={scroller} thumb={thumb} />
        </div>
        <Tree docked={treeColumn > 0} shown={shown} state={state} store={store} />
      </div>
    </div>
  )
}

/* 滑块的几何：内容有多长、此刻停在哪。滚动体没得滚时不画条。
 * 公式单独导出并带单测：贴顶、贴底、不越界这三条在屏幕上看不出换算错了。 */
export interface Thumb {
  readonly visible: boolean
  readonly height: number
  readonly offset: number
}

/** 滑块最短 32px：长清单里那一条再细就抓不住了。 */
const THUMB_MIN = 32

export function thumbOf(clientHeight: number, scrollHeight: number, scrollTop: number): Thumb {
  if (scrollHeight <= clientHeight) {
    return { height: 0, offset: 0, visible: false }
  }
  const height = Math.max(THUMB_MIN, (clientHeight / scrollHeight) * clientHeight)
  /* 滑块走多远，内容就走多少：两边都按「可走距离」的比例换算。 */
  const offset = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - height)
  return { height, offset, visible: true }
}

function useOverlayScrollbar(scroller: RefObject<HTMLDivElement | null>): Thumb {
  /* 滑块高度按「可视比」走，位置按 scrollTop 比例走；两者都要在滚动、改尺寸、内容变化后重算。
   * 内容变化（展开一份 diff、换一份清单）不会触发 scroll 事件，所以要盯子树。 */
  const [thumb, setThumb] = useState<Thumb>({ height: 0, offset: 0, visible: false })
  useEffect(() => {
    const el = scroller.current
    if (el === null) {
      return
    }
    const measure = (): void => {
      const next = thumbOf(el.clientHeight, el.scrollHeight, el.scrollTop)
      /* 同值不换对象：滚动每帧都会调到这里。 */
      setThumb((held) =>
        held.visible === next.visible && held.height === next.height && Math.abs(held.offset - next.offset) < 0.5
          ? held
          : next,
      )
    }
    measure()
    /* 滚动体自己的盒子变了（拖宽、换窗口）要重量。 */
    const resize = new ResizeObserver(measure)
    resize.observe(el)
    /* 内容高度变了（展开一份 diff、清单换了一份）也要重量，而那不会改滚动体自己的盒子。
     * 盯子树而不是只盯当前那几个孩子：卡是整批换的，旧节点会被摘掉。 */
    const mutation = new MutationObserver(measure)
    mutation.observe(el, { childList: true, subtree: true })
    el.addEventListener('scroll', measure, { passive: true })
    return () => {
      resize.disconnect()
      mutation.disconnect()
      el.removeEventListener('scroll', measure)
    }
  }, [scroller])
  return thumb
}

/* 覆盖式滚动条：绝对定位在滚动体右缘，不参与布局，所以不占宽度。
 * 能拖：按下滑块后按位移换算成滚动量，指针捕获归滑块自己，拖出滚动体也不会断。 */
function OverlayScrollbar({
  scroller,
  thumb,
}: {
  readonly scroller: RefObject<HTMLDivElement | null>
  readonly thumb: Thumb
}) {
  const drag = useRef<{ readonly startY: number; readonly startTop: number } | null>(null)
  if (!thumb.visible) {
    return null
  }
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const el = scroller.current
    if (el === null) {
      return
    }
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { startTop: el.scrollTop, startY: event.clientY }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const held = drag.current
    const el = scroller.current
    if (held === null || el === null) {
      return
    }
    /* 滑块走多远，内容就走多少：两者按 travel 的比例换算。 */
    const travel = el.clientHeight - thumb.height
    if (travel <= 0) {
      return
    }
    const moved = event.clientY - held.startY
    el.scrollTop = held.startTop + (moved / travel) * (el.scrollHeight - el.clientHeight)
  }
  const stopDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }
  return (
    <div aria-hidden className="review-scrollbar">
      <div
        className="review-scrollbar__thumb"
        onPointerCancel={stopDrag}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDrag}
        style={{ height: `${String(thumb.height)}px`, transform: `translateY(${String(thumb.offset)}px)` }}
      />
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
  if (shown.length === 0) {
    return <Note>没有匹配的文件。</Note>
  }
  return (
    <>
      {shown.map((file) => (
        <Card
          file={file}
          key={file.path}
          onToggle={store.toggleFile}
          onToggleGap={store.toggleGap}
          open={state.openFiles.has(file.path)}
          openGaps={state.openGaps}
          scroller={scroller}
          wrap={state.presentation.wrap}
        />
      ))}
    </>
  )
}
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
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <Overflow state={state} store={store} />
        <IconButton
          label={allOpen ? '折叠全部差异' : '展开全部差异'}
          onClick={() => {
            store.setAllOpen(!allOpen)
          }}
        >
          {allOpen ? <FoldVertical aria-hidden /> : <UnfoldVertical aria-hidden />}
        </IconButton>
        <IconButton label="变更文件树" onClick={store.toggleTree} pressed={state.treeOpen}>
          <Folders aria-hidden />
        </IconButton>
        <Commit reading={reading} state={state} store={store} />
      </div>
    </div>
  )
}
/* 档位、分组、选中打勾与不可用置灰照 waku 的 diff 来源选择器。六档先全部摆上：本仓现在只有「工作树对某个 ref」一条路，落得下
 * 的只有未提交与分支；其余四档 ref 为 null 即尚无实现。 */
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
        <ChevronDown aria-hidden className=" opacity-40" />
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
              {source.ref !== null && source.ref === base ? <DropdownMenuCheck /> : null}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
function Overflow({ state, store }: { readonly state: ReviewState; readonly store: ReviewStore }) {
  const copyCommand = (): void => {
    void store.applyCommand().then((command) => {
      if (command !== '') {
        void navigator.clipboard.writeText(command)
      }
    })
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="更多操作" className={ICON_CLASS}>
        <MoreHorizontal aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuItem onClick={store.refresh}>
          <RefreshCw aria-hidden />
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
            <entry.icon aria-hidden />
            <span className={ROW_CLASS}>{state.presentation[entry.name] ? entry.on : entry.off}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!store.hasChanges()} onClick={copyCommand}>
          <Copy aria-hidden />
          <span className={ROW_CLASS}>复制 git apply 命令</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
function Commit({
  reading,
  state,
  store,
}: {
  readonly reading: Ready
  readonly state: ReviewState
  readonly store: ReviewStore
}) {
  const canCommit = !state.busy && reading.files.length > 0 && (state.stageAll || reading.staged.size > 0)
  const canPush = !state.busy && (reading.ahead > 0 || reading.upstream === null)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="review-toolbar-action ml-1 flex h-6 shrink-0 items-center gap-1 rounded-md border border-current/15 px-2 text-xs disabled:opacity-50"
        disabled={state.busy}
      >
        <GithubMark className="opacity-60" />
        {state.busy ? '正在提交…' : '提交或推送'}
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
            {state.stageAll ? <Check aria-hidden /> : null}
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
          <GitCommitHorizontal aria-hidden />
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
          <ArrowUp aria-hidden />
          <span className="min-w-0 flex-1 truncate text-xs">提交并推送</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="rounded-xl px-3"
          disabled={!canPush}
          onClick={() => {
            store.commit('push')
          }}
        >
          <Upload aria-hidden />
          <span className="min-w-0 flex-1 truncate text-xs">推送</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
/* 一张卡只认自己那一份：store 里别的字段（草稿、筛选、分隔条、别的文件的补丁）换了都不重渲 ——
 * 一次文件解析或一次拖拽要让所有卡重画整棵 diff 是这条界面最贵的一笔。 */
const Card = memo(function Card({
  file,
  onToggle,
  onToggleGap,
  open,
  openGaps,
  scroller,
  wrap,
}: {
  readonly file: DiffFile
  readonly onToggle: (path: string) => void
  readonly onToggleGap: (key: string) => void
  readonly open: boolean
  readonly openGaps: ReadonlySet<string>
  readonly scroller: RefObject<HTMLDivElement | null>
  readonly wrap: boolean
}) {
  const cut = file.path.lastIndexOf('/')
  const fileName = cut === -1 ? file.path : file.path.slice(cut + 1)
  const fileDir = cut === -1 ? undefined : file.path.slice(0, cut + 1)
  /* 视口外的卡跳过绘制，没有估高滚动条会随视口推进跳动；行数按展开态算。 */
  const rows = open ? renderedRowsOf(file, openGaps) : 0
  const style: ReviewStyle = { '--review-card-rows': String(rows) }
  return (
    <section className="review-card" id={cardId(file.path)} style={style}>
      {/* 两层：外层整宽不透明钉在滚动口上缘，内层药丸给悬浮底色；margin 收出留白、
       * padding 补回行内起点 —— 比工具条那条内线再右挪 4px，文件名不贴着图标站。 */}
      <header className="review-card__head">
        <div className="review-card__head-row mx-1.5 flex h-7 items-center gap-2 rounded-md px-2">
          <button
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-left"
            onClick={() => {
              onToggle(file.path)
            }}
            type="button"
          >
            <FileTypeMark name={file.path} />
            <span className="shrink-0 text-sm">
              <bdi>{fileName}</bdi>
            </span>
            {fileDir ? (
              <span className="review-card__dir min-w-0 text-sm opacity-50">
                <bdi>{fileDir}</bdi>
              </span>
            ) : null}
            <Tally stat={file.stat} />
          </button>
        </div>
      </header>
      {open ? <Body file={file} onToggleGap={onToggleGap} openGaps={openGaps} scroller={scroller} wrap={wrap} /> : null}
    </section>
  )
})

function Body({
  file,
  onToggleGap,
  openGaps,
  scroller,
  wrap,
}: {
  readonly file: DiffFile
  readonly onToggleGap: (key: string) => void
  readonly openGaps: ReadonlySet<string>
  readonly scroller: RefObject<HTMLDivElement | null>
  readonly wrap: boolean
}) {
  if (file.binary) {
    return <Note>二进制文件，没有可对比的文本。</Note>
  }
  if (file.rows.length === 0) {
    return (
      <div className="review-empty flex h-11 items-center justify-center">
        <span className="text-xs">无内容</span>
      </div>
    )
  }
  return <DiffBody file={file} onToggleGap={onToggleGap} openGaps={openGaps} scroller={scroller} wrap={wrap} />
}
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
  /* 树只在路径、折叠态或处境变了时重建；打开一个文件、写草稿、拖分隔条都不该让它重排。 */
  const paths = useMemo(() => shown.map((file) => file.path), [shown])
  const rows: readonly FileTreeRow[] = useMemo(
    () =>
      pathTreeRows(paths, state.collapsedFolders).map((row) =>
        row.kind === 'folder' ? { ...row, expanded: !state.collapsedFolders.has(row.key) } : row,
      ),
    [paths, state.collapsedFolders],
  )
  const statuses = state.reading.phase === 'ready' ? state.reading.statuses : null
  return (
    <aside className="review-tree" inert={!docked}>
      <div className="review-tree__clip">
        <div className="review-tree__surface flex flex-col" style={{ width: `${String(state.treeWidth)}px` }}>
          {/* 筛选是输入框而不是工具条：一条圆角药丸圈住图标与输入。左内边距 8 + 8 让
           * 放大镜落在树行图标的竖线上；右侧留 8px 给清除键 —— 再小它的方形悬浮底
           * 就顶出药丸的弧。 */}
          <div className="flex shrink-0 px-2 py-2">
            <div className="review-filter flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-full pr-2 pl-2.5">
              <Search aria-hidden className=" text-placeholder" />
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
                  <X aria-hidden />
                </IconButton>
              </span>
            </div>
          </div>
          {rows.length === 0 ? (
            <div className="review-tree__scroll min-h-0 flex-1 overflow-y-auto px-2 py-1">
              <Note>没有匹配的文件。</Note>
            </div>
          ) : (
            <FileTree
              className="review-tree__scroll min-h-0 flex-1 px-2 py-1"
              dragText={(row) => (row.kind === 'file' ? row.key : null)}
              label="变更文件"
              onOpen={(row) => {
                const opening = !state.openFiles.has(row.key)
                store.toggleFile(row.key)
                if (opening) {
                  document.getElementById(cardId(row.key))?.scrollIntoView({ block: 'start' })
                }
              }}
              onToggle={(row) => {
                store.toggleFolder(row.key)
              }}
              rows={rows}
              trailing={(row) => {
                const status = row.kind === 'file' ? statuses?.get(row.key) : undefined
                return status === undefined ? null : <ChangeMark status={status} />
              }}
            />
          )}
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
function cardId(path: string): string {
  return `review:${path}`
}
/* 只认 git 清单说的 status，不从加减行数反推（+0 −1 是删掉一行的改写，不是删文件）；目录不给徽章。 */
const MARK_LABELS: Readonly<Record<FileChange, string>> = {
  added: '新增',
  conflicted: '冲突',
  copied: '复制',
  deleted: '删除',
  modified: '修改',
  renamed: '改名',
  untracked: '未跟踪',
}
function ChangeMark({ status }: { readonly status: FileChange }) {
  const label = MARK_LABELS[status]
  return (
    <span
      aria-label={label}
      className="review-mark flex size-[13px] shrink-0 items-center justify-center rounded-[4px]"
      data-status={status}
      role="img"
    >
      {status === 'deleted' ? (
        <span aria-hidden className="font-bold text-[13px] leading-none">
          D
        </span>
      ) : status === 'added' || status === 'untracked' ? (
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
      <TooltipTrigger aria-label={label} aria-pressed={pressed} className={ICON_CLASS} onClick={onClick}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
/* 0/0 也写：没有文本改动是一份数出来的结果，与「没数」不是一回事。 */
function Tally({
  dense = false,
  stat,
}: {
  /** 收一档。 */
  readonly dense?: boolean
  readonly stat: DiffStat
}) {
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5 tabular-nums', dense ? 'text-[11px]' : 'text-[13px]')}>
      <span className="text-emerald-500">+{stat.added}</span>
      <span className="text-rose-500">−{stat.removed}</span>
    </span>
  )
}
function Note({ children }: { readonly children: ReactNode }) {
  return <p className="px-2.5 py-2 text-xs opacity-50">{children}</p>
}
