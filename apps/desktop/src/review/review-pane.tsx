import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FileTypeMark,
  RegionSplitter,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@poietica/ui'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  GitBranch,
  MoreHorizontal,
  PanelRight,
  Search,
  X,
} from 'lucide-react'
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { useConversationWorkspaceRoot } from '../assistant/threads-context'
import { type ChangeTreeFile, type ChangeTreeFolder, changeTreeRows } from './change-tree'
import {
  createReviewStore,
  type ReviewReading,
  type ReviewState,
  type ReviewStore,
  type ReviewSwitch,
  TREE_MAX,
  TREE_MIN,
} from './review-store'
import type { DiffBand, DiffPiece, DiffRow, ReviewFile } from './unified-diff'

import './review-pane.css'

/*
 * 审查那一格：这条对话所在工作树的差异面。
 *
 * 这里只画。清单、补丁、折叠、树宽、呈现开关都在 review-store 那一份快照里，
 * 组件不持有领域态，也不自己问 git。
 */
type Ready = Extract<ReviewReading, { phase: 'ready' }>
const TROUBLE: Readonly<Record<'asking' | 'notARepository' | 'unreadable', string>> = {
  asking: '正在读取变更…',
  notARepository: '这个目录不是 git 仓库。',
  unreadable: '读不到 git 变更。',
}
/* 列宽走注册过的自定义属性，与外壳那一份同构。 */
type ReviewStyle = CSSProperties & Record<`--${string}`, string>
/* 种类由行模型说，不由行首字符说：所以正文里不留 +/- 那一列。取色在 review-pane.css。 */
const TONES: Readonly<Record<DiffRow['kind'], string>> = {
  added: 'review-line review-line--added',
  context: 'review-line',
  removed: 'review-line review-line--removed',
}
const SWITCHES: readonly {
  readonly name: ReviewSwitch
  readonly on: string
  readonly off: string
}[] = [
  { name: 'wrap', off: '启用自动换行', on: '禁用自动换行' },
  { name: 'tightContext', off: '不加载完整文件', on: '加载完整文件' },
  { name: 'wordDiff', off: '启用文字差异', on: '禁用文字差异' },
  { name: 'hideWhitespace', off: '隐藏空白字符', on: '显示空白字符' },
]
const ICON_CLASS =
  'flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-current/10 hover:opacity-100'
/* 行内动作小一档：行头只有 h-7，24px 的方块会顶到上下沿。 */
const ROW_ICON_CLASS =
  'flex size-5 shrink-0 items-center justify-center rounded opacity-60 hover:bg-current/10 hover:opacity-100'
const ROW_CLASS = 'min-w-0 flex-1 truncate text-xs'
export function ReviewPane({ conversationId }: { readonly conversationId: string | null }) {
  const root = useConversationWorkspaceRoot(conversationId)
  if (root === null) {
    return <Note>这条对话没有工作目录。</Note>
  }
  return <Review key={root} root={root} />
}
function Review({ root }: { readonly root: string }) {
  const store = useMemo(() => createReviewStore(root), [root])
  useEffect(() => store.start(), [store])
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const reading = state.reading
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
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Cards reading={reading} shown={shown} state={state} store={store} />
        </div>
        <Tree docked={treeColumn > 0} shown={shown} state={state} store={store} />
      </div>
    </div>
  )
}
function Cards({
  reading,
  shown,
  state,
  store,
}: {
  readonly reading: Ready
  readonly shown: readonly ReviewFile[]
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
        <Card file={file} key={file.path} reading={reading} state={state} store={store} />
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
  const head = reading.head ?? reading.detachedAt ?? 'HEAD'
  return (
    <div className="flex h-[var(--ui-control-height-sm)] shrink-0 items-center gap-2 border-b border-current/10 px-2.5">
      <Bases base={state.base} reading={reading} store={store}>
        <GitBranch aria-hidden className="size-3.5 shrink-0 opacity-60" />
        <span className="max-w-28 truncate text-xs">{head}</span>
        <span aria-hidden className="text-xs opacity-40">
          →
        </span>
        <span className="max-w-28 truncate text-xs opacity-70">{state.base}</span>
        <ChevronDown aria-hidden className="size-3 shrink-0 opacity-50" />
      </Bases>
      <Tally additions={reading.additions} deletions={reading.deletions} />
      {reading.ahead + reading.behind > 0 ? (
        <span className="shrink-0 font-mono text-[11px] tabular-nums opacity-50">
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
            <ChevronDown aria-hidden className="size-4" />
          ) : (
            <ChevronRight aria-hidden className="size-4" />
          )}
        </IconButton>
        <IconButton label="变更文件树" onClick={store.toggleTree} pressed={state.treeOpen}>
          <PanelRight aria-hidden className="size-4" />
        </IconButton>
        <Commit reading={reading} state={state} store={store} />
      </div>
    </div>
  )
}
function Bases({
  base,
  children,
  reading,
  store,
}: {
  readonly base: string
  readonly children: ReactNode
  readonly reading: Ready
  readonly store: ReviewStore
}) {
  const refs = [
    ...new Set([
      'HEAD',
      ...(reading.upstream === null ? [] : [reading.upstream]),
      ...reading.branches,
    ]),
  ]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="比较基准"
        className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 opacity-80 hover:bg-current/10 hover:opacity-100"
      >
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        {/* 搜索态住在菜单内容里：菜单一关它随之卸载，不需要谁去清它。 */}
        <BaseList base={base} refs={refs} store={store} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
function BaseList({
  base,
  refs,
  store,
}: {
  readonly base: string
  readonly refs: readonly string[]
  readonly store: ReviewStore
}) {
  const [needle, setNeedle] = useState('')
  const shown = refs.filter((ref) => ref.toLowerCase().includes(needle.trim().toLowerCase()))
  return (
    <>
      <div className="mx-1 mb-1 flex items-center gap-1.5 rounded-md border border-current/15 px-2 py-1.5">
        <Search aria-hidden className="size-3.5 shrink-0 opacity-50" />
        <input
          aria-label="搜索分支"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:opacity-50"
          onChange={(event) => {
            setNeedle(event.target.value)
          }}
          onKeyDown={(event) => {
            /* 菜单把方向键与字母当导航；搜索框里它们是输入。 */
            if (event.key !== 'Escape' && event.key !== 'Tab') {
              event.stopPropagation()
            }
          }}
          placeholder="搜索分支"
          value={needle}
        />
      </div>
      <p className="px-2 pb-1 text-[11px] opacity-40">分支</p>
      {shown.length === 0 ? (
        <p className="px-2 py-1 text-xs opacity-50">没有匹配的分支。</p>
      ) : (
        shown.map((ref) => (
          <DropdownMenuItem
            key={ref}
            onClick={() => {
              store.setBase(ref)
            }}
          >
            <span className={ROW_CLASS}>{ref}</span>
            {ref === base ? <span className="shrink-0 text-[11px] opacity-50">当前</span> : null}
          </DropdownMenuItem>
        ))
      )}
    </>
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
  const [message, setMessage] = useState('')
  const [stageAll, setStageAll] = useState(true)
  const head = reading.head ?? reading.detachedAt ?? 'HEAD'
  const canCommit = !state.busy && reading.files.length > 0 && (stageAll || reading.staged.size > 0)
  const canPush = !state.busy && (reading.ahead > 0 || reading.upstream === null)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="ml-1 flex h-6 shrink-0 items-center gap-1 rounded-md border border-current/15 px-2 text-xs hover:bg-current/10 disabled:opacity-50"
        disabled={state.busy}
      >
        <GitBranch aria-hidden className="size-3.5 opacity-60" />
        {state.busy ? '正在提交…' : '提交或推送'}
        <ChevronDown aria-hidden className="size-3 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72">
        <p className="flex items-center gap-1.5 px-2 pb-1 text-xs opacity-60">
          <GitBranch aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{head}</span>
        </p>
        <div className="mx-1 mb-1 rounded-md border border-current/15 px-2 py-1.5">
          <textarea
            aria-label="提交信息"
            className="w-full resize-none bg-transparent text-xs outline-none placeholder:opacity-50"
            onChange={(event) => {
              setMessage(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                if (canCommit) {
                  store.commit('commit', message, stageAll)
                }
                return
              }
              /* 菜单把方向键与字母当导航；说明框里它们是输入。 */
              if (event.key !== 'Escape' && event.key !== 'Tab') {
                event.stopPropagation()
              }
            }}
            placeholder="提交信息（留空将自动生成）…"
            rows={3}
            value={message}
          />
        </div>
        <label className="mx-1 flex items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-current/10">
          <input
            checked={stageAll}
            className="size-3 accent-current"
            onChange={(event) => {
              setStageAll(event.target.checked)
            }}
            type="checkbox"
          />
          <span className="min-w-0 flex-1">包含未暂存的更改</span>
          <Tally additions={reading.unstaged.additions} deletions={reading.unstaged.deletions} />
        </label>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!canCommit}
          onClick={() => {
            store.commit('commit', message, stageAll)
          }}
        >
          <span className={ROW_CLASS}>提交</span>
          <span className="shrink-0 font-mono text-[11px] opacity-40">Ctrl+↵</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!canCommit}
          onClick={() => {
            store.commit('commit-and-push', message, stageAll)
          }}
        >
          <span className={ROW_CLASS}>提交并推送</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!canPush}
          onClick={() => {
            store.commit('push', '', false)
          }}
        >
          <span className={ROW_CLASS}>推送</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
function Card({
  file,
  reading,
  state,
  store,
}: {
  readonly file: ReviewFile
  readonly reading: Ready
  readonly state: ReviewState
  readonly store: ReviewStore
}) {
  const open = state.openFiles.has(file.path)
  return (
    <section id={cardId(file.path)}>
      <header className="group flex h-7 items-center gap-2 px-2.5">
        <button
          aria-expanded={open}
          className="flex min-w-0 items-center gap-2 text-left"
          onClick={() => {
            store.toggleFile(file.path)
          }}
          title={file.path}
          type="button"
        >
          <FileTypeMark className="size-3.5 shrink-0" name={file.path} />
          <span className="min-w-0 truncate text-xs">{file.path}</span>
          <Tally additions={file.additions} deletions={file.deletions} />
        </button>
        {/* 悬浮或键盘聚焦时才出现：行头默认只有事实。 */}
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
          <IconButton
            dense
            label="复制相对路径"
            onClick={() => {
              /* git 给的就是仓库根的相对路径；复制失败交给全局未处理拒绝那条策略。 */
              void navigator.clipboard.writeText(file.path)
            }}
          >
            <Copy aria-hidden className="size-3" />
          </IconButton>
          <IconButton
            dense
            label={open ? '折叠这个文件' : '展开这个文件'}
            onClick={() => {
              store.toggleFile(file.path)
            }}
          >
            {open ? (
              <ChevronDown aria-hidden className="size-3" />
            ) : (
              <ChevronRight aria-hidden className="size-3" />
            )}
          </IconButton>
        </div>
        {reading.staged.has(file.path) ? (
          <span className="ml-auto shrink-0 text-[11px] opacity-40">已暂存</span>
        ) : null}
      </header>
      {open ? <Body file={file} state={state} store={store} /> : null}
    </section>
  )
}
function Body({
  file,
  state,
  store,
}: {
  readonly file: ReviewFile
  readonly state: ReviewState
  readonly store: ReviewStore
}) {
  if (file.binary) {
    return <Note>二进制文件，没有可对比的文本。</Note>
  }
  if (file.bands.length === 0) {
    return <Note>没有文本改动。</Note>
  }
  /* 不换行时这一格自己横滚：代码的缩进不能被折行改写。 */
  return (
    <div
      className={cn(
        'font-mono text-[11px] leading-5',
        state.presentation.wrap ? null : 'overflow-x-auto',
      )}
    >
      {file.bands.map((band) => (
        <Band
          band={band}
          key={bandKey(file.path, band)}
          path={file.path}
          state={state}
          store={store}
        />
      ))}
    </div>
  )
}
function bandKey(path: string, band: DiffBand): string {
  if (band.kind === 'gap') {
    return `${path}#${band.gap.id}`
  }
  const first = band.rows[0]
  return `${path}@${first === undefined ? 'x' : rowKey(first)}`
}
function Band({
  band,
  path,
  state,
  store,
}: {
  readonly band: DiffBand
  readonly path: string
  readonly state: ReviewState
  readonly store: ReviewStore
}) {
  const wrap = state.presentation.wrap
  if (band.kind === 'rows') {
    return <Rows rows={band.rows} wrap={wrap} />
  }
  const key = `${path}#${band.gap.id}`
  const open = state.openGaps.has(key)
  const label = `${String(band.gap.lines)} unmodified lines`
  return (
    <>
      <GapBar
        label={open ? `折叠 ${label}` : label}
        onClick={
          band.gap.rows.length === 0
            ? undefined
            : () => {
                store.toggleGap(key)
              }
        }
        open={open}
      />
      {open ? <Rows rows={band.gap.rows} wrap={wrap} /> : null}
    </>
  )
}
/* rows 为空的带子展不开：那些行确实没取回来，按下去也无可显示。 */
function GapBar({
  label,
  onClick,
  open,
}: {
  readonly label: string
  readonly onClick?: () => void
  readonly open: boolean
}) {
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <button
      className="flex w-full items-center gap-1.5 border-y border-current/10 bg-current/5 px-2.5 text-left text-[10px] opacity-50 enabled:hover:opacity-90"
      disabled={onClick === undefined}
      onClick={onClick}
      type="button"
    >
      <Chevron aria-hidden className="size-3 shrink-0" />
      {label}
    </button>
  )
}
function Rows({ rows, wrap }: { readonly rows: readonly DiffRow[]; readonly wrap: boolean }) {
  return (
    <div className={wrap ? undefined : 'w-max min-w-full'}>
      {rows.map((row) => (
        <Line key={rowKey(row)} row={row} wrap={wrap} />
      ))}
    </div>
  )
}
/* 一份文件里唯一：删除行没有新行号，用旧行号加前缀，不与另两种撞。 */
function rowKey(row: DiffRow): string {
  return row.newLine === null ? `o${String(row.oldLine)}` : `n${String(row.newLine)}`
}
/* 单一行号槽 —— 统一视图里两列行号只有一列是答案。 */
function Line({ row, wrap }: { readonly row: DiffRow; readonly wrap: boolean }) {
  return (
    <div className={cn('flex items-start pr-2.5', TONES[row.kind])}>
      <span className="w-11 shrink-0 select-none pr-2 text-right tabular-nums opacity-30">
        {row.newLine ?? row.oldLine}
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
}
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
  readonly shown: readonly ReviewFile[]
  readonly state: ReviewState
  readonly store: ReviewStore
}) {
  const byPath = new Map(shown.map((file) => [file.path, file] as const))
  const rows = changeTreeRows([...byPath.keys()], state.collapsedFolders)
  /* 收起只是列宽归零：子树不卸载，滚动位置与展开状态不随开合重建。 */
  return (
    <aside className="review-tree" inert={!docked}>
      <div className="review-tree__clip">
        <div
          className={cn(
            'review-tree__surface flex flex-col border-l',
            state.splitter === 'idle' ? 'border-current/10' : 'border-current/30',
          )}
          style={{ width: `${String(state.treeWidth)}px` }}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-current/10 px-2 py-1.5">
            <Search aria-hidden className="size-3.5 shrink-0 opacity-50" />
            <input
              aria-label="筛选文件"
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:opacity-50"
              onChange={(event) => {
                store.setQuery(event.target.value)
              }}
              placeholder="筛选文件…"
              value={state.query}
            />
            {state.query === '' ? null : (
              <IconButton
                label="清除筛选"
                onClick={() => {
                  store.setQuery('')
                }}
              >
                <X aria-hidden className="size-3.5" />
              </IconButton>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
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
                  <FileRow
                    file={byPath.get(row.path)}
                    key={row.key}
                    open={state.openFiles.has(row.path)}
                    row={row}
                    store={store}
                  />
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
      className="flex w-full items-center gap-1.5 py-1 pr-2 text-left hover:bg-current/5"
      onClick={() => {
        store.toggleFolder(row.key)
      }}
      style={{ paddingInlineStart: `${String(8 + row.depth * 12)}px` }}
      type="button"
    >
      {collapsed ? (
        <ChevronRight aria-hidden className="size-3 shrink-0 opacity-40" />
      ) : (
        <ChevronDown aria-hidden className="size-3 shrink-0 opacity-40" />
      )}
      <Folder aria-hidden className="size-3.5 shrink-0 opacity-40" />
      <span className="min-w-0 flex-1 truncate text-xs opacity-70">{row.label}</span>
      <span className="shrink-0 font-mono text-[11px] tabular-nums opacity-30">
        {row.paths.length}
      </span>
    </button>
  )
}
function FileRow({
  file,
  open,
  row,
  store,
}: {
  readonly file: ReviewFile | undefined
  readonly open: boolean
  readonly row: ChangeTreeFile
  readonly store: ReviewStore
}) {
  return (
    <div
      className="group flex items-center gap-1 py-1 pr-1 hover:bg-current/5"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', row.path)
        event.dataTransfer.effectAllowed = 'copy'
      }}
      role="listitem"
      style={{ paddingInlineStart: `${String(8 + row.depth * 12)}px` }}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        onClick={() => {
          store.openFile(row.path)
          document.getElementById(cardId(row.path))?.scrollIntoView({ block: 'start' })
        }}
        title={row.path}
        type="button"
      >
        <FileTypeMark className="size-3.5 shrink-0" name={row.label} />
        <span className="min-w-0 flex-1 truncate text-xs">{row.label}</span>
        {file === undefined ? null : (
          <Tally additions={file.additions} deletions={file.deletions} />
        )}
      </button>
      <span className="shrink-0 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
        <IconButton
          dense
          label={open ? '折叠这个文件' : '展开这个文件'}
          onClick={() => {
            store.toggleFile(row.path)
          }}
        >
          {open ? (
            <ChevronDown aria-hidden className="size-3" />
          ) : (
            <ChevronRight aria-hidden className="size-3" />
          )}
        </IconButton>
      </span>
    </div>
  )
}
/* 树里点一行要能滚到对应的卡：id 由路径直接给，getElementById 不需要转义。 */
function cardId(path: string): string {
  return `review:${path}`
}
function IconButton({
  children,
  dense = false,
  label,
  onClick,
  pressed,
}: {
  readonly children: ReactNode
  /** 行内动作用小一档。 */
  readonly dense?: boolean
  readonly label: string
  readonly onClick: () => void
  readonly pressed?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        aria-pressed={pressed}
        className={dense ? ROW_ICON_CLASS : ICON_CLASS}
        onClick={onClick}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
/* 两侧都写出来：删除专场也要看得见 +0，这是「数过了」与「没数」的区别。 */
function Tally({
  additions,
  deletions,
}: {
  readonly additions: number
  readonly deletions: number
}) {
  if (additions === 0 && deletions === 0) {
    return null
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
      <span className="text-emerald-500">+{additions}</span>
      <span className="text-rose-500">−{deletions}</span>
    </span>
  )
}
function Note({ children }: { readonly children: ReactNode }) {
  return <p className="px-2.5 py-2 text-xs opacity-50">{children}</p>
}
