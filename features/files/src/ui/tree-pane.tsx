import { cn, FileTree, type FileTreeRow, Tooltip, TooltipContent, TooltipTrigger } from '@poietica/design-system'
import type { WorkspacesUi } from '@poietica/feature-workspaces/ui-api'
import { useFeatureStore, useLayout } from '@poietica/ui-kernel'
import { Crosshair, FolderTree, ListCollapse, RefreshCw, Search, X } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useSyncExternalStore } from 'react'
import type { FileOpener } from './opener'
import type { FileTabsStore } from './tabs'
import type { FileTreeModel } from './tree-model'
import type { FileTreeModels } from './tree-models'
import './files.css'

/*
 * 右坞「文件」：当前工作区的整棵目录树（懒加载），点文件在右坞开一个标签。树本身是 design-system 的 FileTree ——
 * 与审查的变更树同一棵，缩进、引导线、Material 文件图标逐像素一致。
 */

export interface FilesTreePanelProps {
  readonly models: FileTreeModels
  readonly opener: FileOpener
  readonly tabs: FileTabsStore
  readonly workspaces: WorkspacesUi
}

export function FilesTreePanel({ models, opener, tabs, workspaces }: FilesTreePanelProps): ReactNode {
  const workspaceId = useFeatureStore(workspaces.store, (held) => held.activeId)
  const name = useFeatureStore(workspaces.store, (held) => held.items.find((w) => w.id === held.activeId)?.name ?? null)
  const owner = useLayout().auxiliary.owner
  if (workspaceId === null) {
    return <Placeholder title="还没有工作区">先添加一个工作区，这里会列出它的文件。</Placeholder>
  }
  return (
    <TreeView
      key={workspaceId}
      model={models.obtain(workspaceId)}
      name={name}
      onOpen={(path) => {
        if (owner !== null) opener.openListed(owner, workspaceId, path)
      }}
      owner={owner}
      tabs={tabs}
      workspaceId={workspaceId}
    />
  )
}

/* 右坞此刻（这位归属）选中的文件，且属于这个工作区：树里高亮它。 */
function useSelectedPath(tabs: FileTabsStore, owner: string | null, workspaceId: string): string | null {
  const set = useSyncExternalStore(
    useCallback((listener: () => void) => tabs.subscribe(listener), [tabs]),
    () => tabs.of(owner),
  )
  const tab = set?.activeId === null || set?.activeId === undefined ? undefined : tabs.tab(set.activeId)
  return tab?.workspaceId === workspaceId ? tab.path : null
}

function TreeView({
  model,
  name,
  onOpen,
  owner,
  tabs,
  workspaceId,
}: {
  readonly model: FileTreeModel
  readonly name: string | null
  readonly onOpen: (path: string) => void
  readonly owner: string | null
  readonly tabs: FileTabsStore
  readonly workspaceId: string
}) {
  useSyncExternalStore(model.subscribe, model.version)
  useEffect(() => {
    model.start()
  }, [model])
  const selected = useSelectedPath(tabs, owner, workspaceId)
  const rows = model.rows()
  const query = model.queryText()
  const filtering = query.trim() !== ''
  const onToggle = useCallback((row: FileTreeRow) => model.toggle(row), [model])
  const onOpenRow = useCallback((row: FileTreeRow) => onOpen(row.key), [onOpen])
  const onRevealed = useCallback((key: string) => model.revealed(key), [model])

  return (
    <div className="files-pane flex h-full min-h-0 flex-col">
      <div className="files-rule flex h-[var(--ui-control-height-sm)] items-center gap-1 px-2.5">
        <FolderTree aria-hidden className=" opacity-50" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium opacity-70">{name ?? '工作区'}</span>
        <IconButton
          disabled={selected === null}
          label="在树中定位当前文件"
          onClick={() => {
            if (selected !== null) model.reveal(selected)
          }}
        >
          <Crosshair aria-hidden />
        </IconButton>
        <IconButton label="全部折叠" onClick={() => model.collapseAll()}>
          <ListCollapse aria-hidden />
        </IconButton>
        <IconButton label="刷新" onClick={() => model.reload()}>
          <RefreshCw aria-hidden />
        </IconButton>
      </div>
      <Filter onChange={(next) => model.setQuery(next)} value={query} />
      <TreeBody filtering={filtering} model={model} />
      {/* 树自己是滚动口（虚拟化要它）；末尾那句提示钉在树下，滚到哪都看得见。 */}
      {rows.length > 0 ? (
        <FileTree
          className="min-h-0 flex-1 px-2 pb-2"
          dragText={(row) => (row.kind === 'file' ? row.key : null)}
          label="工作区文件"
          onOpen={onOpenRow}
          onRevealed={onRevealed}
          onToggle={onToggle}
          revealKey={model.revealTarget()}
          rows={rows}
          selectedKey={selected}
        />
      ) : null}
      <TreeFooter filtering={filtering} model={model} />
    </div>
  )
}

/* 树上方的那一句：读不到、正在读、空目录、没有匹配。有行可画时不出声。 */
function TreeBody({ filtering, model }: { readonly filtering: boolean; readonly model: FileTreeModel }) {
  if (model.rows().length > 0) return null
  if (filtering) {
    const search = model.searchState()
    if (search.phase === 'failed') return <Note>筛选失败，稍后再试。</Note>
    return <Note>{search.phase === 'ready' ? '没有匹配的文件。' : '正在筛选…'}</Note>
  }
  const phase = model.rootState()
  if (phase === 'failed') return <Note>读不到这个工作区的目录。</Note>
  return <Note>{phase === 'ready' ? '这个工作区是空的。' : '正在读取…'}</Note>
}

function TreeFooter({ filtering, model }: { readonly filtering: boolean; readonly model: FileTreeModel }) {
  const search = model.searchState()
  if (filtering && search.phase === 'ready' && search.truncated) {
    return <Note>结果太多，只列出前 {search.hits.length} 个；再多打几个字。</Note>
  }
  if (!filtering && model.anyTruncated()) {
    return <Note>有的目录条目太多，只列出了一部分；用上方的筛选找文件。</Note>
  }
  return null
}

/* 与审查的筛选框同一形制：一条圆角药丸圈住图标与输入，清除键常占位、有字没字一样高。 */
function Filter({ onChange, value }: { readonly onChange: (value: string) => void; readonly value: string }) {
  return (
    <div className="flex px-2 py-2">
      <div className="files-filter flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-full pr-2 pl-2.5">
        <Search aria-hidden className=" text-placeholder" />
        <input
          aria-label="筛选文件"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-placeholder"
          onChange={(event) => {
            onChange(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && value !== '') {
              event.preventDefault()
              onChange('')
            }
          }}
          placeholder="筛选文件…"
          value={value}
        />
        <span className={value === '' ? 'invisible' : undefined}>
          <IconButton label="清除筛选" onClick={() => onChange('')}>
            <X aria-hidden />
          </IconButton>
        </span>
      </div>
    </div>
  )
}

export function IconButton({
  children,
  disabled = false,
  label,
  onClick,
  pressed,
}: {
  readonly children: ReactNode
  readonly disabled?: boolean
  readonly label: string
  readonly onClick: () => void
  readonly pressed?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        aria-pressed={pressed}
        className={cn(
          'files-action flex size-6  items-center justify-center rounded-md opacity-60 hover:opacity-100',
          disabled ? 'pointer-events-none opacity-30' : null,
        )}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function Note({ children }: { readonly children: ReactNode }) {
  return <p className="px-2.5 py-2 text-xs opacity-50">{children}</p>
}

export function Placeholder({ children, title }: { readonly children: ReactNode; readonly title: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <FolderTree aria-hidden className=" opacity-30" />
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs opacity-50">{children}</p>
    </div>
  )
}
