import { RotateCw, Search } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { useActiveWorkspaceRoot } from '../workspace-root'
import { type GitFileChange, useFilePatch, useWorkspaceChanges } from './workspace-changes'

/*
 * 审查那一格：dock 里的只读变更清单。
 *
 * 筛选词不落盘：下次打开时一个看不见的筛选词会惄惄藏掉文件。
 */

const STATUS_MARKS: Readonly<Record<GitFileChange['status'], readonly [string, string]>> = {
  added: ['A', 'text-emerald-500'],
  modified: ['M', 'text-amber-500'],
  deleted: ['D', 'text-rose-500'],
  untracked: ['?', 'text-sky-500'],
  conflicted: ['U', 'text-rose-500'],
}

export function ReviewPane() {
  const root = useActiveWorkspaceRoot()
  const { answered, changes, refresh, revision } = useWorkspaceChanges(root)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-current/10 px-2.5">
        <span className="text-xs font-medium">Git 变更</span>
        {changes === null ? null : (
          <span className="text-xs tabular-nums opacity-50">{changes.length}</span>
        )}
        <button
          aria-label="刷新"
          className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-current/10 hover:opacity-100"
          onClick={refresh}
          title="刷新"
          type="button"
        >
          <RotateCw aria-hidden className="size-3.5" />
        </button>
      </div>
      <ReviewList
        answered={answered}
        changes={changes}
        key={root ?? 'none'}
        revision={revision}
        root={root}
      />
    </div>
  )
}

function ReviewList({
  answered,
  changes,
  revision,
  root,
}: {
  readonly answered: boolean
  readonly changes: readonly GitFileChange[] | null
  readonly revision: number
  readonly root: string | null
}) {
  const [query, setQuery] = useState('')

  if (root === null) {
    return <Note>没有打开的工作目录。</Note>
  }

  if (!answered) {
    return <Note>正在读取变更…</Note>
  }

  if (changes === null) {
    return <Note>这个目录不是 git 仓库。</Note>
  }

  if (changes.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
        <p className="text-sm font-medium">尚无文件变更</p>
        <p className="text-xs opacity-50">项目变更将显示在此处</p>
      </div>
    )
  }

  const needle = query.trim().toLowerCase()
  const matched = changes.filter((change) => change.path.toLowerCase().includes(needle))

  return (
    <>
      <div className="mx-2 mt-2 flex shrink-0 items-center gap-2 rounded-md border border-current/10 px-2 py-1.5">
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
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {matched.map((change) => (
          <FileRow change={change} key={change.path} revision={revision} root={root} />
        ))}
        {matched.length === 0 ? <Note>没有匹配的文件。</Note> : null}
      </div>
    </>
  )
}

function FileRow({
  change,
  revision,
  root,
}: {
  readonly change: GitFileChange
  readonly revision: number
  readonly root: string
}) {
  const [open, setOpen] = useState(false)
  const [mark, tone] = STATUS_MARKS[change.status]

  return (
    <div>
      <button
        aria-expanded={open}
        className="flex h-8 w-full min-w-0 items-center gap-2 px-2.5 text-left hover:bg-current/5"
        onClick={() => {
          setOpen(!open)
        }}
        title={change.path}
        type="button"
      >
        <span className={'shrink-0 font-mono text-[11px] ' + tone}>{mark}</span>
        <span className="min-w-0 flex-1 truncate text-xs">{change.path}</span>
        {change.staged ? <span className="shrink-0 text-[11px] opacity-50">已暂存</span> : null}
      </button>
      {open ? <RowPatch change={change} revision={revision} root={root} /> : null}
    </div>
  )
}

function RowPatch({
  change,
  revision,
  root,
}: {
  readonly change: GitFileChange
  readonly revision: number
  readonly root: string
}) {
  if (change.status === 'untracked') {
    return <Note>未跟踪的文件没有对比基线。</Note>
  }

  return <TrackedPatch path={change.path} revision={revision} root={root} />
}

function TrackedPatch({
  path,
  revision,
  root,
}: {
  readonly path: string
  readonly revision: number
  readonly root: string
}) {
  const patch = useFilePatch(root, path, revision)

  if (patch.state === 'asking') {
    return <Note>正在读取补丁…</Note>
  }

  if (patch.state === 'refused') {
    return <Note>补丁读取失败。</Note>
  }

  return (
    <pre className="max-h-64 overflow-auto px-2.5 pb-2 font-mono text-[11px] leading-5">
      {hunkLines(patch.patch).map((line, index) => (
        <div className={patchTone(line)} key={String(index) + line}>
          {line}
        </div>
      ))}
    </pre>
  )
}

/* 只画补丁本体：头几行（diff / index / --- / +++）说的是文件名，标题行已经说过。 */
function hunkLines(patch: string): readonly string[] {
  const lines = patch.split('\n')
  const start = lines.findIndex((line) => line.startsWith('@@'))

  return start === -1 ? [] : lines.slice(start)
}

function patchTone(line: string): string {
  if (line.startsWith('+')) {
    return 'text-emerald-500'
  }

  if (line.startsWith('-')) {
    return 'text-rose-500'
  }

  if (line.startsWith('@@')) {
    return 'opacity-50'
  }

  return ''
}

function Note({ children }: { readonly children: ReactNode }) {
  return <p className="px-2.5 py-2 text-xs opacity-50">{children}</p>
}
