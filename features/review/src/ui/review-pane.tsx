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
import { type CSSProperties, Fragment, type ReactNode, type RefObject, useRef } from 'react'
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
  const cut = file.path.lastIndexOf('/')
  const fileName = cut === -1 ? file.path : file.path.slice(cut + 1)
  const fileDir = cut === -1 ? undefined : file.path.slice(0, cut + 1)
  /* 视口外的卡跳过绘制，没有估高滚动条会随视口推进跳动；行数按展开态算。 */
  const rows = open ? renderedRowsOf(file, state.openGaps) : 0
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
              store.toggleFile(file.path)
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
      {open ? <Body file={file} scroller={scroller} state={state} store={store} /> : null}
    </section>
  )
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
    return (
      <div className="review-empty flex h-11 items-center justify-center">
        <span className="text-xs">无内容</span>
      </div>
    )
  }
  return (
    <DiffBody
      file={file}
      onToggleGap={store.toggleGap}
      openGaps={state.openGaps}
      scroller={scroller}
      wrap={state.presentation.wrap}
    />
  )
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
  const rows: readonly FileTreeRow[] = pathTreeRows(
    shown.map((file) => file.path),
    state.collapsedFolders,
  ).map((row) => (row.kind === 'folder' ? { ...row, expanded: !state.collapsedFolders.has(row.key) } : row))
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
