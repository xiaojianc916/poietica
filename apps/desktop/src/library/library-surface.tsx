import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@poietica/design-system'
import type {
  LibraryController,
  LibraryEntry,
  LibraryFormat,
  LibraryState,
} from '@poietica/library'
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Code,
  Eye,
  FileText,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Save,
  Search,
  Table,
  Trash2,
  Upload,
} from 'lucide-react'
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react'
import { MarkdownContent } from './markdown-content'

const ROOT_LABEL = '我的资料'

/** 三种格式在界面上的读法，顺序就是新建菜单的顺序。 */
const FORMATS = [
  { format: 'markdown', label: '新建文档（.md）', Mark: FileText },
  { format: 'table', label: '新建表格（.csv）', Mark: Table },
  { format: 'page', label: '新建网页（.html）', Mark: Code },
] as const satisfies readonly { format: LibraryFormat; label: string; Mark: typeof FileText }[]

/** 一行条目能发出的全部意图。落点由点下去的那一行给出，不靠全局选中态推断。 */
interface LibraryIntents {
  readonly open: (path: string) => void
  readonly create: (parent: string, format: LibraryFormat) => void
  readonly folder: (parent: string) => void
  readonly importFile: (parent: string) => void
  readonly rename: (path: string, name: string) => void
  readonly trash: (path: string) => void
}

function siblings(entries: readonly LibraryEntry[]): Map<string, LibraryEntry[]> {
  const grouped = new Map<string, LibraryEntry[]>()

  for (const entry of entries) {
    const found = grouped.get(entry.parent)

    if (found === undefined) {
      grouped.set(entry.parent, [entry])
    } else {
      found.push(entry)
    }
  }

  return grouped
}

function CreateMenu({
  intents,
  label,
  parent,
}: {
  intents: LibraryIntents
  label: string
  parent: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Plus aria-hidden="true" className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {FORMATS.map(({ format, label: title, Mark }) => (
          <DropdownMenuItem key={format} onClick={() => intents.create(parent, format)}>
            <Mark aria-hidden="true" className="size-4" />
            {title}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => intents.folder(parent)}>
          <FolderPlus aria-hidden="true" className="size-4" />
          新建文件夹
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => intents.importFile(parent)}>
          <Upload aria-hidden="true" className="size-4" />
          导入文件
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function EntryRow({
  depth,
  entry,
  intents,
  opened,
  renaming,
  setRenaming,
  tree,
}: {
  depth: number
  entry: LibraryEntry
  intents: LibraryIntents
  opened: string | undefined
  renaming: string | null
  setRenaming: (path: string | null) => void
  tree: Map<string, LibraryEntry[]>
}) {
  const [expanded, setExpanded] = useState(true)
  const folder = entry.format === null
  const Mark = folder
    ? Folder
    : (FORMATS.find((item) => item.format === entry.format)?.Mark ?? FileText)

  if (renaming === entry.path) {
    return (
      <form
        className="flex h-8 items-center px-2"
        onSubmit={(event) => {
          event.preventDefault()

          const value = new FormData(event.currentTarget).get('name')

          setRenaming(null)

          if (typeof value === 'string' && value.trim().length > 0) {
            intents.rename(entry.path, value.trim())
          }
        }}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <input
          aria-label="新名称"
          className="min-w-0 flex-1 rounded border border-input bg-background px-1 py-0.5 text-sm outline-none"
          defaultValue={entry.name}
          name="name"
          onBlur={() => setRenaming(null)}
          ref={(node) => {
            node?.select()
          }}
        />
      </form>
    )
  }

  return (
    <>
      <div
        className={cn(
          'group flex h-8 items-center gap-1 rounded-md pr-1 text-sm hover:bg-accent',
          entry.path === opened && 'bg-accent font-medium',
        )}
        style={{ paddingLeft: 4 + depth * 12 }}
      >
        <button
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
          onClick={() => (folder ? setExpanded(!expanded) : intents.open(entry.path))}
          type="button"
        >
          {folder ? (
            expanded ? (
              <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            )
          ) : null}
          <Mark aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{entry.name}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="更多操作"
            className="rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
          >
            <MoreHorizontal aria-hidden="true" className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setRenaming(entry.path)}>
              <Pencil aria-hidden="true" className="size-4" />
              重命名
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive"
              onClick={() => intents.trash(entry.path)}
            >
              <Trash2 aria-hidden="true" className="size-4" />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {folder ? (
          <CreateMenu intents={intents} label={`在${entry.name}中新建`} parent={entry.path} />
        ) : null}
      </div>
      {folder && expanded
        ? (tree.get(entry.path) ?? []).map((child) => (
            <EntryRow
              depth={depth + 1}
              entry={child}
              intents={intents}
              key={child.path}
              opened={opened}
              renaming={renaming}
              setRenaming={setRenaming}
              tree={tree}
            />
          ))
        : null}
    </>
  )
}

/** 右侧内容区：位置导航、读写切换与正文。 */
function ContentPane({
  controller,
  mode,
  openLink,
  setMode,
  state,
}: {
  controller: LibraryController
  mode: 'read' | 'edit'
  openLink: (url: string) => void
  setMode: (mode: 'read' | 'edit') => void
  state: LibraryState
}) {
  const opened = state.document
  const trail = opened === null ? [] : opened.path.replaceAll('\\', '/').split('/')
  const readable =
    opened !== null &&
    (state.entries.find((entry) => entry.path === opened.path)?.format ?? 'markdown') === 'markdown'

  return (
    <section aria-label="资料内容" className="flex min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-divider border-b px-4">
        <nav aria-label="位置" className="flex min-w-0 flex-1 items-center gap-1 text-sm">
          <span className="text-muted-foreground">{ROOT_LABEL}</span>
          {trail.map((part, index) => (
            <span
              className="flex min-w-0 items-center gap-1"
              key={trail.slice(0, index + 1).join('/')}
            >
              <span className="text-muted-foreground">/</span>
              <span className="truncate">{part}</span>
            </span>
          ))}
        </nav>
        {state.busy ? <span className="text-muted-foreground text-xs">正在处理…</span> : null}
        {opened === null ? null : (
          <div className="flex items-center gap-1">
            {readable ? (
              <Button
                aria-label={mode === 'read' ? '编辑' : '阅读'}
                onClick={() => setMode(mode === 'read' ? 'edit' : 'read')}
                size="icon"
                variant="ghost"
              >
                {mode === 'read' ? (
                  <Pencil aria-hidden="true" className="size-4" />
                ) : (
                  <Eye aria-hidden="true" className="size-4" />
                )}
              </Button>
            ) : null}
            <Button
              aria-label="保存"
              disabled={!controller.dirty}
              onClick={() => void controller.save()}
              size="icon"
              variant="ghost"
            >
              <Save aria-hidden="true" className="size-4" />
            </Button>
          </div>
        )}
      </header>
      {state.failure === null ? null : (
        <div
          className="flex items-center gap-3 border-divider border-b bg-muted px-4 py-2 text-sm"
          role="alert"
        >
          <p className="min-w-0 flex-1">{state.failure}</p>
          <Button onClick={controller.clearFailure} size="xs" variant="ghost">
            关闭
          </Button>
        </div>
      )}
      {opened === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
          <BookOpen aria-hidden="true" className="size-8" />
          <p className="text-sm">选一份资料开始，或从左侧新建。</p>
        </div>
      ) : readable && mode === 'read' ? (
        <article className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-y-auto px-8 py-6">
          <MarkdownContent content={state.draft} onOpenLink={openLink} />
        </article>
      ) : (
        <textarea
          aria-label="资料源文"
          className="min-h-0 flex-1 resize-none bg-transparent px-8 py-6 font-mono text-sm leading-relaxed outline-none"
          onChange={(event) => controller.edit(event.target.value)}
          spellCheck={false}
          value={state.draft}
        />
      )}
    </section>
  )
}

export function LibrarySurface({
  controller,
  openLink,
}: {
  controller: LibraryController
  openLink: (url: string) => void
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  const [renaming, setRenaming] = useState<string | null>(null)
  const [mode, setMode] = useState<'read' | 'edit'>('read')
  const titleId = useId()
  const tree = useMemo(() => siblings(state.entries), [state.entries])
  const intents = useMemo<LibraryIntents>(
    () => ({
      open: (path) => {
        void controller.open(path).then((opened) => {
          if (opened) {
            setMode('read')
          }
        })
      },
      create: (parent, format) => {
        void controller.create(parent, format).then((made) => {
          if (made) {
            setMode('edit')
          }
        })
      },
      folder: (parent) => {
        void controller.folder(parent)
      },
      importFile: (parent) => {
        void controller.importFile(parent)
      },
      rename: (path, name) => {
        void controller.rename(path, name)
      },
      trash: (path) => {
        void controller.trash(path)
      },
    }),
    [controller],
  )

  useEffect(() => {
    void controller.start()
  }, [controller])

  const opened = state.document

  return (
    <section
      aria-labelledby={titleId}
      className="grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)] bg-ground text-foreground"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          void controller.save()
        }
      }}
    >
      <aside
        aria-label={ROOT_LABEL}
        className="flex min-h-0 flex-col gap-3 border-divider border-r bg-background px-3 pt-5 pb-3"
      >
        <header className="flex items-center gap-2 px-1">
          <BookOpen aria-hidden="true" className="size-5 text-primary" />
          <h1 className="font-semibold text-base" id={titleId}>
            资料库
          </h1>
        </header>
        <div className="flex items-center gap-1.5 rounded-md bg-muted px-2">
          <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <input
            aria-label="搜索资料名与正文"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none"
            onChange={(event) => controller.search(event.target.value)}
            placeholder="搜索"
            type="search"
            value={state.query}
          />
        </div>
        <div className="flex items-center justify-between gap-1 px-1">
          <span className="font-medium text-muted-foreground text-xs">{ROOT_LABEL}</span>
          <CreateMenu intents={intents} label={`在${ROOT_LABEL}中新建`} parent="" />
        </div>
        <nav aria-label={ROOT_LABEL} className="min-h-0 flex-1 overflow-y-auto">
          {state.entries.length === 0 ? (
            <p className="px-2 py-1 text-muted-foreground text-xs leading-relaxed">
              {state.query === '' ? '' : '没有匹配的资料。'}
            </p>
          ) : null}
          {state.query === ''
            ? (tree.get('') ?? []).map((entry) => (
                <EntryRow
                  depth={0}
                  entry={entry}
                  intents={intents}
                  key={entry.path}
                  opened={opened?.path}
                  renaming={renaming}
                  setRenaming={setRenaming}
                  tree={tree}
                />
              ))
            : state.entries
                .filter((entry) => entry.format !== null)
                .map((entry) => (
                  <button
                    className={cn(
                      'flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-sm hover:bg-accent',
                      entry.path === opened?.path && 'bg-accent font-medium',
                    )}
                    key={entry.path}
                    onClick={() => intents.open(entry.path)}
                    type="button"
                  >
                    <FileText
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="truncate">{entry.path}</span>
                  </button>
                ))}
        </nav>
      </aside>
      <ContentPane
        controller={controller}
        mode={mode}
        openLink={openLink}
        setMode={setMode}
        state={state}
      />
    </section>
  )
}
