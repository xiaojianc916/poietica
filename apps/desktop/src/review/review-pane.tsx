import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@poietica/ui'
import { ChevronDown, ChevronRight, GitBranch, MoreHorizontal, Search } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useConversationWorkspaceRoot } from '../assistant/threads-context'
import {
  type ChangeStatus,
  createReviewStore,
  type ReviewReading,
  type ReviewState,
  type ReviewStore,
  type ReviewSwitch,
} from './review-store'
import type { DiffBand, DiffRow, ReviewFile } from './unified-diff'

/*
 * 审查那一格：这条对话所在工作树的差异面。
 *
 * 这里只画。清单、补丁、折叠、已查看、呈现开关都在 review-store 那一份快照里，
 * 组件不持有领域态，也不自己问 git。
 */
type Ready = Extract<ReviewReading, { phase: 'ready' }>
const TROUBLE: Readonly<Record<'asking' | 'notARepository' | 'unreadable', string>> = {
  asking: '正在读取变更…',
  notARepository: '这个目录不是 git 仓库。',
  unreadable: '读不到 git 变更。',
}
const STATUS_MARKS: Readonly<Record<ChangeStatus, readonly [string, string]>> = {
  added: ['A', 'text-emerald-500'],
  conflicted: ['U', 'text-rose-500'],
  deleted: ['D', 'text-rose-500'],
  modified: ['M', 'text-amber-500'],
  untracked: ['?', 'text-sky-500'],
}
/* 种类由行模型说，不由行首字符说：所以正文里不留 +/- 那一列。 */
const TONES: Readonly<Record<DiffRow['kind'], string>> = {
  added: 'border-emerald-500/40 bg-emerald-500/10',
  context: 'border-transparent',
  removed: 'border-rose-500/40 bg-rose-500/10',
}
const EMPHASIS: Readonly<Record<DiffRow['kind'], string>> = {
  added: 'bg-emerald-500/25',
  context: '',
  removed: 'bg-rose-500/25',
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
  'flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-current/10 hover:opacity-100 aria-pressed:bg-current/10 aria-pressed:opacity-100'
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
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar reading={reading} state={state} store={store} />
      <Comparison base={state.base} reading={reading} store={store} />
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {reading.files.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
              <p className="text-sm font-medium">尚无文件变更</p>
              <p className="text-xs opacity-50">项目变更将显示在此处</p>
            </div>
          ) : (
            shown.map((file) => (
              <Card file={file} key={file.path} reading={reading} state={state} store={store} />
            ))
          )}
        </div>
        {state.filesOpen && reading.files.length > 0 ? (
          <Files reading={reading} shown={shown} state={state} store={store} />
        ) : null}
      </div>
    </div>
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
  const allFolded = reading.files.length > 0 && state.folded.size >= reading.files.length
  return (
    <div className="flex h-[var(--ui-control-height-sm)] shrink-0 items-center gap-2 border-b border-current/10 px-2.5">
      <Bases base={state.base} reading={reading} store={store}>
        <GitBranch aria-hidden className="size-3.5 shrink-0 opacity-60" />
        <span className="text-xs">分支</span>
        <ChevronDown aria-hidden className="size-3 shrink-0 opacity-50" />
      </Bases>
      <Tally additions={reading.additions} deletions={reading.deletions} />
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <Overflow state={state} store={store} />
        <IconButton
          label={allFolded ? '展开全部差异' : '折叠全部差异'}
          onClick={() => {
            store.setAllFolded(!allFolded)
          }}
        >
          {allFolded ? (
            <ChevronDown aria-hidden className="size-4" />
          ) : (
            <ChevronRight aria-hidden className="size-4" />
          )}
        </IconButton>
        <IconButton label="筛选文件" onClick={store.toggleFiles} pressed={state.filesOpen}>
          <Search aria-hidden className="size-4" />
        </IconButton>
        <Commit reading={reading} state={state} store={store} />
      </div>
    </div>
  )
}
/* 左边是检出的分支，右边是比较基准；点开就换基准，不在这里换分支。 */
function Comparison({
  base,
  reading,
  store,
}: {
  readonly base: string
  readonly reading: Ready
  readonly store: ReviewStore
}) {
  const head = reading.head ?? reading.detachedAt ?? 'HEAD'
  return (
    <div className="flex h-[var(--ui-control-height-sm)] shrink-0 items-center gap-1.5 border-b border-current/10 px-2.5">
      <Bases base={base} reading={reading} store={store}>
        <span className="max-w-32 truncate text-xs">{head}</span>
        <span aria-hidden className="text-xs opacity-40">
          →
        </span>
        <span className="max-w-32 truncate text-xs opacity-70">{base}</span>
        <ChevronDown aria-hidden className="size-3 shrink-0 opacity-50" />
      </Bases>
      {reading.ahead + reading.behind > 0 ? (
        <span className="shrink-0 font-mono text-[11px] tabular-nums opacity-50">
          ↑{reading.ahead} ↓{reading.behind}
        </span>
      ) : null}
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
      <DropdownMenuContent className="w-52">
        {refs.map((ref) => (
          <DropdownMenuItem
            key={ref}
            onClick={() => {
              store.setBase(ref)
            }}
          >
            <span className={ROW_CLASS}>{ref}</span>
            {ref === base ? <span className="shrink-0 text-[11px] opacity-50">当前</span> : null}
          </DropdownMenuItem>
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
  const dirty = reading.files.length > 0
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
      <DropdownMenuContent className="w-64">
        {dirty ? (
          <div className="mx-1 mb-1 rounded-md border border-current/15 px-2 py-1.5">
            <input
              aria-label="提交说明"
              className="w-full bg-transparent text-xs outline-none placeholder:opacity-50"
              onChange={(event) => {
                setMessage(event.target.value)
              }}
              onKeyDown={(event) => {
                /* 菜单把方向键与字母当导航；说明框里它们是输入。 */
                if (event.key !== 'Escape' && event.key !== 'Tab') {
                  event.stopPropagation()
                }
              }}
              placeholder="提交说明"
              value={message}
            />
          </div>
        ) : null}
        <DropdownMenuItem
          disabled={state.busy || (dirty && message.trim() === '')}
          onClick={() => {
            store.commitOrPush(message)
          }}
        >
          <span className={ROW_CLASS}>{dirty ? '提交或推送' : '推送'}</span>
        </DropdownMenuItem>
        {/* 仓库里没有任何代码托管集成，所以这一项只能是禁用的，并把理由写清楚。 */}
        <DropdownMenuItem disabled title="需要一个已配置的代码托管服务">
          <span className={ROW_CLASS}>创建拉取请求</span>
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
  const status = reading.statuses.get(file.path)
  const folded = state.folded.has(file.path)
  const seen = file.digest !== '' && state.viewed.get(file.path) === file.digest
  return (
    <section className="border-b border-current/10">
      {/* 行头贴顶：长补丁滚起来也知道自己在哪个文件里。 */}
      <header className="sticky top-0 z-10 flex h-7 items-center gap-2 bg-[var(--window-backing-surface)] px-2.5">
        <button
          aria-expanded={!folded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => {
            store.toggleFold(file.path)
          }}
          title={file.path}
          type="button"
        >
          {folded ? (
            <ChevronRight aria-hidden className="size-3.5 shrink-0 opacity-40" />
          ) : (
            <ChevronDown aria-hidden className="size-3.5 shrink-0 opacity-40" />
          )}
          {status === undefined ? null : <Mark status={status} />}
          <span className="min-w-0 truncate text-xs">{file.path}</span>
          <Tally additions={file.additions} deletions={file.deletions} />
        </button>
        {reading.staged.has(file.path) ? (
          <span className="shrink-0 text-[11px] opacity-40">已暂存</span>
        ) : null}
        <label className="flex shrink-0 items-center gap-1.5 text-[11px] opacity-60 hover:opacity-100">
          <input
            checked={seen}
            className="size-3 accent-current"
            onChange={(event) => {
              store.setViewed(file.path, event.target.checked)
            }}
            type="checkbox"
          />
          已标记为已查看
        </label>
      </header>
      {folded ? null : <Body file={file} state={state} store={store} />}
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
    <div className={cn('flex items-start border-l-2 pr-2.5', TONES[row.kind])}>
      <span className="w-11 shrink-0 select-none pr-2 text-right tabular-nums opacity-30">
        {row.newLine ?? row.oldLine}
      </span>
      <span
        className={wrap ? 'min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'}
      >
        {row.text.lead}
        {row.text.middle === '' ? null : (
          <span className={EMPHASIS[row.kind]}>{row.text.middle}</span>
        )}
        {row.text.trail}
      </span>
    </div>
  )
}
function Files({
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
  return (
    <aside className="flex w-56 shrink-0 flex-col border-l border-current/10">
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
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {shown.length === 0 ? (
          <Note>没有匹配的文件。</Note>
        ) : (
          shown.map((file) => (
            <div className="flex items-center gap-2 px-2.5 py-1" key={file.path}>
              <Dot status={reading.statuses.get(file.path)} />
              <span className="min-w-0 flex-1 truncate text-xs" title={file.path}>
                {file.path}
              </span>
              <Tally additions={file.additions} deletions={file.deletions} />
            </div>
          ))
        )}
      </div>
    </aside>
  )
}
function Mark({ status }: { readonly status: ChangeStatus }) {
  const [mark, tone] = STATUS_MARKS[status]
  return <span className={cn('shrink-0 font-mono text-[11px]', tone)}>{mark}</span>
}
function Dot({ status }: { readonly status: ChangeStatus | undefined }) {
  if (status === undefined) {
    return <span aria-hidden className="size-1.5 shrink-0" />
  }
  const [, tone] = STATUS_MARKS[status]
  return <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full bg-current', tone)} />
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
function Tally({
  additions,
  deletions,
}: {
  readonly additions: number
  readonly deletions: number
}) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
      {additions > 0 ? <span className="text-emerald-500">+{additions}</span> : null}
      {deletions > 0 ? <span className="text-rose-500">−{deletions}</span> : null}
    </span>
  )
}
function Note({ children }: { readonly children: ReactNode }) {
  return <p className="px-2.5 py-2 text-xs opacity-50">{children}</p>
}
