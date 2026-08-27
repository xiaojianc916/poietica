import { cn } from '@poietica/ui'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { type ReactNode, useCallback, useMemo, useState } from 'react'

import { useConversationWorkspaceRoot } from '../assistant/threads-context'
import { type PatchLine, patchView } from './patch-hunks'
import {
  type GitFileChange,
  useFilePatch,
  useWorkspaceChanges,
  type WorkspaceChanges,
} from './workspace-changes'

/*
 * 审查那一格：这条对话所在工作树的只读变更面。
 *
 * 清单、加减行数、代次都出自 workspace-changes 的那一份快照，这一格只画。
 * 一格里只有一根竖滚动条：长行换行，不横滚 —— 审查是读代码，不是拖代码。
 * 筛选词与展开集是这一格的呈现态，不落盘、不回灌。
 */

const STATUS_MARKS: Readonly<Record<GitFileChange['status'], readonly [string, string]>> = {
  added: ['A', 'text-emerald-500'],
  modified: ['M', 'text-amber-500'],
  deleted: ['D', 'text-rose-500'],
  untracked: ['?', 'text-sky-500'],
  conflicted: ['U', 'text-rose-500'],
}

/* 种类由行模型说，不由行首字符说：所以正文里不留 +/- 那一列。 */
const LINE_TONES: Readonly<Record<PatchLine['kind'], string>> = {
  added: 'border-emerald-500/40 bg-emerald-500/10',
  removed: 'border-rose-500/40 bg-rose-500/10',
  context: 'border-transparent',
}

/* 一次铺开这么多行，滚动就跟不上手：先问一句再画。 */
const HEAVY_LINES = 500

export function ReviewPane({ conversationId }: { readonly conversationId: string | null }) {
  const root = useConversationWorkspaceRoot(conversationId)
  const changes = useWorkspaceChanges(root)
  const listed = changes.state === 'listed' ? changes.changes : []

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-current/10 px-2.5">
        <span className="text-xs font-medium">Git 变更</span>
        {listed.length > 0 ? (
          <>
            <span className="text-xs tabular-nums opacity-50">{listed.length}</span>
            <span className="ml-auto">
              <Tally additions={sum(listed, 'additions')} deletions={sum(listed, 'deletions')} />
            </span>
          </>
        ) : null}
      </div>
      <ReviewBody changes={changes} key={root ?? 'none'} root={root} />
    </div>
  )
}

function sum(changes: readonly GitFileChange[], field: 'additions' | 'deletions'): number {
  let total = 0

  for (const change of changes) {
    total += change[field]
  }

  return total
}

/* 有行可画才展开：未跟踪没有基线，二进制与纯模式变更没有文本，点开只会是一句话。 */
function readable(change: GitFileChange): boolean {
  return change.additions + change.deletions > 0
}

function ReviewBody({
  changes,
  root,
}: {
  readonly changes: WorkspaceChanges
  readonly root: string | null
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set<string>())

  const toggle = useCallback((path: string) => {
    setOpen((held) => {
      const next = new Set<string>(held)

      if (!next.delete(path)) {
        next.add(path)
      }

      return next
    })
  }, [])

  if (root === null) {
    return <Note>这条对话没有工作目录。</Note>
  }

  if (changes.state === 'asking') {
    return <Note>正在读取变更…</Note>
  }

  if (changes.state === 'notARepository') {
    return <Note>这个目录不是 git 仓库。</Note>
  }

  if (changes.state === 'unreadable') {
    return <Note>读不到 git 变更。</Note>
  }

  if (changes.changes.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
        <p className="text-sm font-medium">尚无文件变更</p>
        <p className="text-xs opacity-50">项目变更将显示在此处</p>
      </div>
    )
  }

  const needle = query.trim().toLowerCase()
  const matched = changes.changes.filter((change) => change.path.toLowerCase().includes(needle))
  const openable = matched.filter(readable)

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-current/10 px-2 py-1.5">
          <Search aria-hidden className="size-3.5 shrink-0 opacity-50" />
          <input
            aria-label="筛选文件"
            className="w-full bg-transparent text-xs outline-none placeholder:opacity-50"
            onChange={(event) => {
              setQuery(event.target.value)
            }}
            placeholder="筛选文件"
            value={query}
          />
        </div>
        {openable.length > 0 ? (
          <button
            className="shrink-0 rounded-md px-1.5 py-1 text-xs opacity-60 hover:bg-current/10 hover:opacity-100"
            onClick={() => {
              setOpen(
                open.size > 0
                  ? new Set<string>()
                  : new Set<string>(openable.map((change) => change.path)),
              )
            }}
            type="button"
          >
            {open.size > 0 ? '折叠全部' : '展开全部'}
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {matched.length === 0 ? (
          <Note>没有匹配的文件。</Note>
        ) : (
          matched.map((change) => (
            <FileRow
              change={change}
              generation={changes.generation}
              key={change.path}
              onToggle={toggle}
              open={open.has(change.path)}
              root={root}
            />
          ))
        )}
      </div>
    </>
  )
}

function FileRow({
  change,
  generation,
  onToggle,
  open,
  root,
}: {
  readonly change: GitFileChange
  readonly generation: number
  readonly onToggle: (path: string) => void
  readonly open: boolean
  readonly root: string
}) {
  const [mark, tone] = STATUS_MARKS[change.status]
  const cut = change.path.lastIndexOf('/')
  const openable = readable(change)
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <div>
      {/* 行头贴顶：长补丁滚起来也知道自己在哪个文件里。 */}
      <button
        aria-expanded={openable ? open : undefined}
        className="sticky top-0 z-10 flex h-7 w-full items-center gap-2 bg-[var(--window-backing-surface)] px-2.5 text-left enabled:hover:bg-current/5"
        disabled={!openable}
        onClick={() => {
          onToggle(change.path)
        }}
        title={change.path}
        type="button"
      >
        {openable ? (
          <Chevron aria-hidden className="size-3.5 shrink-0 opacity-40" />
        ) : (
          <span aria-hidden className="size-3.5 shrink-0" />
        )}
        <span className={cn('shrink-0 font-mono text-[11px]', tone)}>{mark}</span>
        <span className="min-w-0 flex-1 truncate text-xs">
          {change.path.slice(cut + 1)}
          {cut > 0 ? <span className="ml-1.5 opacity-40">{change.path.slice(0, cut)}</span> : null}
        </span>
        {change.staged ? <span className="shrink-0 text-[11px] opacity-40">已暂存</span> : null}
        {openable ? (
          <Tally additions={change.additions} deletions={change.deletions} />
        ) : (
          <span className="shrink-0 text-[11px] opacity-40">{stalled(change)}</span>
        )}
      </button>
      {openable && open ? <Patch change={change} generation={generation} root={root} /> : null}
    </div>
  )
}

/* 展不开的，把原因写在行上：点一下才发现没内容，不是答案。 */
function stalled(change: GitFileChange): string {
  if (change.status === 'untracked') {
    return '未跟踪'
  }

  if (change.status === 'conflicted') {
    return '冲突'
  }

  return '无文本改动'
}

function Patch({
  change,
  generation,
  root,
}: {
  readonly change: GitFileChange
  readonly generation: number
  readonly root: string
}) {
  const patch = useFilePatch(root, change.path, generation)
  const [forced, setForced] = useState(false)
  const text = patch.state === 'ready' ? patch.patch : ''
  /* 解析跟着补丁文本走：重渲染不重解一遍同一段文本。 */
  const view = useMemo(() => patchView(text), [text])
  const lines = change.additions + change.deletions

  if (patch.state === 'asking') {
    return <Note>正在读取补丁…</Note>
  }

  if (patch.state === 'refused') {
    return <Note>补丁读取失败。</Note>
  }

  if (view.binary) {
    return <Note>二进制文件，没有可对比的文本。</Note>
  }

  if (view.empty) {
    return <Note>没有文本改动。</Note>
  }

  if (lines > HEAVY_LINES && !forced) {
    return (
      <div className="flex flex-col items-start gap-2 px-2.5 py-2">
        <p className="text-xs opacity-50">{lines} 行改动，一次画完会拖住滚动。</p>
        <button
          className="rounded-md border border-current/15 px-2 py-1 text-xs hover:bg-current/10"
          onClick={() => {
            setForced(true)
          }}
          type="button"
        >
          仍然展开
        </button>
      </div>
    )
  }

  return (
    <div className="font-mono text-[11px] leading-5">
      {view.hunks.map((hunk) => (
        <div key={hunk.header}>
          <div className="border-y border-current/10 bg-current/5 px-2.5 text-[10px] opacity-40">
            {hunk.header}
          </div>
          {hunk.lines.map((line) => (
            <Line key={lineKey(line)} line={line} />
          ))}
        </div>
      ))}
    </div>
  )
}

/* 行号在一段 hunk 里唯一：删除行取负，与新增和上下文不会撞。 */
function lineKey(line: PatchLine): number {
  return line.newLine ?? -(line.oldLine ?? 0)
}

/* 行号两列、正文一列；正文换行，所以这一格里没有横向滚动条。 */
function Line({ line }: { readonly line: PatchLine }) {
  return (
    <div className={cn('flex items-start gap-2 border-l-2 pr-2.5 pl-2', LINE_TONES[line.kind])}>
      <span className="w-7 shrink-0 select-none text-right tabular-nums opacity-30">
        {line.oldLine}
      </span>
      <span className="w-7 shrink-0 select-none text-right tabular-nums opacity-30">
        {line.newLine}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {line.text}
      </span>
    </div>
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
