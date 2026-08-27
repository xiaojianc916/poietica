import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { useConversationWorkspaceRoot } from '../assistant/threads-context'
import { type FileTreeFolder, type FileTreeNode, fileTree } from './file-tree'
import { type PatchLine, patchView } from './patch-hunks'
import {
  type GitFileChange,
  useFilePatch,
  useWorkspaceChanges,
  type WorkspaceChanges,
} from './workspace-changes'

/*
 * 审查那一格：屏幕上这条对话所在工作树的只读变更面。
 *
 * 目录不是这一格的状态，是这条对话的事实（ThreadRecord.workspaceRoot）。清单由
 * 原生监视推着走，所以这里没有刷新按钮 —— 一个能按的刷新意味着屏幕允许停在过期
 * 的答案上。筛选词不落盘：下次打开时一个看不见的筛选词会静静藏掉文件。
 */

const STATUS_MARKS: Readonly<Record<GitFileChange['status'], readonly [string, string]>> = {
  added: ['A', 'text-emerald-500'],
  modified: ['M', 'text-amber-500'],
  deleted: ['D', 'text-rose-500'],
  untracked: ['?', 'text-sky-500'],
  conflicted: ['U', 'text-rose-500'],
}

const LINE_TONES: Readonly<Record<PatchLine['kind'], string>> = {
  added: 'bg-emerald-500/10',
  removed: 'bg-rose-500/10',
  context: '',
}

const LINE_MARKS: Readonly<Record<PatchLine['kind'], string>> = {
  added: '+',
  removed: '-',
  context: ' ',
}

/* 树的缩进：一层一格，行首留出与标题同宽的边距。 */
const GUTTER = 10
const INDENT_STEP = 12

function indent(depth: number): { readonly paddingLeft: number } {
  return { paddingLeft: GUTTER + depth * INDENT_STEP }
}

export function ReviewPane({ conversationId }: { readonly conversationId: string | null }) {
  const root = useConversationWorkspaceRoot(conversationId)
  const changes = useWorkspaceChanges(root)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-current/10 px-2.5">
        <span className="text-xs font-medium">Git 变更</span>
        {changes.state === 'listed' ? (
          <span className="text-xs tabular-nums opacity-50">{changes.changes.length}</span>
        ) : null}
      </div>
      <ReviewBody changes={changes} key={root ?? 'none'} root={root} />
    </div>
  )
}

function ReviewBody({
  changes,
  root,
}: {
  readonly changes: WorkspaceChanges
  readonly root: string | null
}) {
  const [query, setQuery] = useState('')

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
        {matched.length === 0 ? (
          <Note>没有匹配的文件。</Note>
        ) : (
          <Branch depth={0} generation={changes.generation} nodes={fileTree(matched)} root={root} />
        )}
      </div>
    </>
  )
}

function Branch({
  depth,
  generation,
  nodes,
  root,
}: {
  readonly depth: number
  readonly generation: number
  readonly nodes: readonly FileTreeNode[]
  readonly root: string
}) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === 'folder' ? (
          <Folder depth={depth} generation={generation} key={node.path} node={node} root={root} />
        ) : (
          <FileRow
            change={node.change}
            depth={depth}
            generation={generation}
            key={node.change.path}
            name={node.name}
            root={root}
          />
        ),
      )}
    </>
  )
}

function Folder({
  depth,
  generation,
  node,
  root,
}: {
  readonly depth: number
  readonly generation: number
  readonly node: FileTreeFolder
  readonly root: string
}) {
  const [open, setOpen] = useState(true)
  const Glyph = open ? ChevronDown : ChevronRight

  return (
    <div>
      <button
        aria-expanded={open}
        className="flex h-7 w-full min-w-0 items-center gap-1.5 pr-2.5 text-left hover:bg-current/5"
        onClick={() => {
          setOpen(!open)
        }}
        style={indent(depth)}
        title={node.path}
        type="button"
      >
        <Glyph aria-hidden className="size-3.5 shrink-0 opacity-50" />
        <span className="min-w-0 flex-1 truncate text-xs opacity-70">{node.name}</span>
      </button>
      {open ? (
        <Branch depth={depth + 1} generation={generation} nodes={node.children} root={root} />
      ) : null}
    </div>
  )
}

function FileRow({
  change,
  depth,
  generation,
  name,
  root,
}: {
  readonly change: GitFileChange
  readonly depth: number
  readonly generation: number
  readonly name: string
  readonly root: string
}) {
  const [open, setOpen] = useState(false)
  const [mark, tone] = STATUS_MARKS[change.status]

  return (
    <div>
      <button
        aria-expanded={open}
        className="flex h-7 w-full min-w-0 items-center gap-2 pr-2.5 text-left hover:bg-current/5"
        onClick={() => {
          setOpen(!open)
        }}
        style={indent(depth)}
        title={change.path}
        type="button"
      >
        <span className={`shrink-0 font-mono text-[11px] ${tone}`}>{mark}</span>
        <span className="min-w-0 flex-1 truncate text-xs">{name}</span>
        {change.staged ? <span className="shrink-0 text-[11px] opacity-50">已暂存</span> : null}
      </button>
      {open ? <Patch change={change} generation={generation} root={root} /> : null}
    </div>
  )
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

  if (patch.state === 'asking') {
    return <Note>正在读取补丁…</Note>
  }

  if (patch.state === 'refused') {
    return <Note>补丁读取失败。</Note>
  }

  const view = patchView(patch.patch)

  if (view.binary) {
    return <Note>二进制文件，没有可对比的文本。</Note>
  }

  if (view.empty) {
    return (
      <Note>{change.status === 'untracked' ? '未跟踪的文件没有对比基线。' : '没有文本改动。'}</Note>
    )
  }

  return (
    <div className="max-h-72 overflow-auto font-mono text-[11px] leading-5">
      {view.hunks.map((hunk, index) => (
        <div key={hunk.header + String(index)}>
          <div className="bg-current/5 px-2.5 opacity-50">{hunk.header}</div>
          {hunk.lines.map((line, at) => (
            <Line key={String(at)} line={line} />
          ))}
        </div>
      ))}
    </div>
  )
}

/* 行号两列、种类一列、正文一列 —— 与 git 自己的 diff 同一读法。 */
function Line({ line }: { readonly line: PatchLine }) {
  return (
    <div className={`flex gap-2 px-2.5 ${LINE_TONES[line.kind]}`}>
      <span className="w-8 shrink-0 text-right tabular-nums opacity-40">{line.oldLine}</span>
      <span className="w-8 shrink-0 text-right tabular-nums opacity-40">{line.newLine}</span>
      <span className="shrink-0 opacity-60">{LINE_MARKS[line.kind]}</span>
      <span className="whitespace-pre">{line.text}</span>
    </div>
  )
}

function Note({ children }: { readonly children: ReactNode }) {
  return <p className="px-2.5 py-2 text-xs opacity-50">{children}</p>
}
