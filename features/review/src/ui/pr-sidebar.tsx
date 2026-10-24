import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@poietica/design-system'
import { Ellipsis, Funnel, RefreshCw, Search, X } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import type { GithubPullSummary, GithubRepository } from '../contract'
import { Avatar } from './avatar'
import { pullStatePresentation, relativeTime, STATE_GLYPHS } from './pr-format'
import type { PrFilter, PrState } from './pr-store'

import './pr-sidebar.css'

/*
 * 代码审查页的左栏：标题 + 搜索 + 过滤标签 + PR 列表。
 *
 * 纯展示：数据与回调全部从 props 进来 —— 这里不碰 RPC、不建 store，也不认识页面里另外两栏。
 * 状态词与配色一律问 pr-format（列表行与详情头读的是同一份映射），本文件不写第二份，
 * 否则两处对同一个 PR 会各说各的。
 */

export interface PrSidebarProps {
  readonly state: PrState
  readonly repository: GithubRepository | null
  /** 已按 filter + query 过滤好的条目；本栏不再自己筛。 */
  readonly entries: readonly GithubPullSummary[]
  readonly counts: { readonly all: number; readonly prs: number; readonly issues: number }
  readonly onFilter: (filter: PrFilter) => void
  readonly onQuery: (query: string) => void
  readonly onSelect: (number: number) => void
  /** 鼠标停在 / 焦点落在某一行（null：离开了）：页面拿它预读详情。 */
  readonly onPrefetch?: (number: number | null) => void
  readonly onRefresh: () => void
}

const FILTERS: readonly { readonly label: string; readonly value: PrFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'PRs', value: 'prs' },
  { label: 'Issues', value: 'issues' },
]

/* 标题行右侧那两枚：安静（次要墨色），悬停才抬起底色。 */
const ICON_BUTTON =
  'flex size-7  items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

export function PrSidebar(p: PrSidebarProps): ReactNode {
  const { state } = p
  const loading = state.reading.phase === 'asking'
  const rows = useRef(new Map<number, HTMLButtonElement>())
  const fromKeyboard = useRef(false)
  /* 漫游 tabindex：没有选中项时让第一行接住 Tab，键盘进得来。 */
  const tabbable = state.selected ?? p.entries[0]?.number ?? null

  /* 上下键只改选中；焦点交给下面那个 effect —— 浏览器随之把这一行带进视口。 */
  const step = (delta: number): void => {
    if (p.entries.length === 0) return
    const index = p.entries.findIndex((entry) => entry.number === state.selected)
    const at = index === -1 ? (delta > 0 ? 0 : p.entries.length - 1) : index + delta
    const next = p.entries[Math.min(Math.max(at, 0), p.entries.length - 1)]
    if (next === undefined) return
    fromKeyboard.current = true
    p.onSelect(next.number)
  }

  useEffect(() => {
    if (!fromKeyboard.current) return
    fromKeyboard.current = false
    if (state.selected === null) return
    rows.current.get(state.selected)?.focus()
  }, [state.selected])

  return (
    <aside className="pr-sidebar flex h-full min-h-0 flex-col">
      <SidebarHead
        busy={state.busy}
        counts={p.counts}
        filter={state.filter}
        /* 背后重读（回到页面、手动刷新）时只让刷新钮转，不把列表换成加载态。 */
        loading={loading || state.refreshing}
        onFilter={p.onFilter}
        onQuery={p.onQuery}
        onRefresh={p.onRefresh}
        query={state.query}
      />
      {/* 滚动只发生在这一格：头与搜索框钉在上面，列表长短不影响另外两栏。 */}
      <nav
        aria-busy={loading}
        aria-label="Code review list"
        className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-6"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          step(event.key === 'ArrowDown' ? 1 : -1)
        }}
      >
        {p.entries.length === 0 ? (
          <EmptyList loading={loading} query={state.query} />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {p.entries.map((entry) => (
              <PullRow
                entry={entry}
                key={entry.number}
                onPrefetch={p.onPrefetch}
                onSelect={p.onSelect}
                register={(number, node) => {
                  if (node === null) rows.current.delete(number)
                  else rows.current.set(number, node)
                }}
                selected={entry.number === state.selected}
                tabbable={entry.number === tabbable}
              />
            ))}
          </ul>
        )}
      </nav>
    </aside>
  )
}

/* 标题行 + 搜索框 + 过滤标签：三行同一套左右内边距，搜索药丸的两端与标题、图标钮对齐。 */
function SidebarHead({
  busy,
  counts,
  filter,
  loading,
  onFilter,
  onQuery,
  onRefresh,
  query,
}: {
  readonly busy: boolean
  readonly counts: { readonly all: number; readonly prs: number; readonly issues: number }
  readonly filter: PrFilter
  readonly loading: boolean
  readonly onFilter: (filter: PrFilter) => void
  readonly onQuery: (query: string) => void
  readonly onRefresh: () => void
  readonly query: string
}): ReactNode {
  const narrowed = query !== '' || filter !== 'all'
  return (
    <div className=" px-3 pt-2 pb-1">
      <div className="flex h-9 items-center gap-1">
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">Code review</h1>
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="Filter" className={ICON_BUTTON} title="Filter">
            <Funnel aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuRadioGroup
              onValueChange={(value) => {
                const picked = FILTERS.find((tab) => tab.value === value)
                if (picked !== undefined) onFilter(picked.value)
              }}
              value={filter}
            >
              {FILTERS.map((tab) => (
                <DropdownMenuRadioItem key={tab.value} value={tab.value}>
                  <span className="min-w-0 flex-1 truncate text-xs">{tab.label}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="More code review actions" className={ICON_BUTTON} title="More">
            <Ellipsis aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem
              disabled={busy || loading}
              onClick={() => {
                onRefresh()
              }}
            >
              <RefreshCw aria-hidden className={cn(' ', loading && 'animate-spin')} />
              <span className="min-w-0 flex-1 truncate text-xs">{loading ? 'Refreshing…' : 'Refresh'}</span>
            </DropdownMenuItem>
            {narrowed ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    onFilter('all')
                    onQuery('')
                  }}
                >
                  <X aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-xs">Clear filters</span>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="mt-1">
        <SearchField onQuery={onQuery} query={query} />
        <FilterTabs counts={counts} filter={filter} onFilter={onFilter} />
      </div>
    </div>
  )
}

/* 搜索：一条圆角药丸圈住放大镜与输入。清除键常占位 —— 有字没字行高等一边高，行不跳。 */
function SearchField({
  query,
  onQuery,
}: {
  readonly query: string
  readonly onQuery: (value: string) => void
}): ReactNode {
  return (
    <div className="pr-sidebar__search flex h-8 min-w-0 items-center gap-1.5 rounded-full pr-1 pl-2.5">
      <Search aria-hidden className=" text-placeholder" />
      <input
        aria-label="Search or paste a PR link"
        className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-placeholder"
        onChange={(event) => {
          onQuery(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onQuery('')
          }
        }}
        placeholder="Search or paste a PR link"
        value={query}
      />
      <span className={query === '' ? 'invisible' : undefined}>
        <button
          aria-label="Clear search"
          className={ICON_BUTTON}
          onClick={() => {
            onQuery('')
          }}
          type="button"
        >
          <X aria-hidden />
        </button>
      </span>
    </div>
  )
}

/* 三档过滤：短标签 + 紧随其后的计数。计数是「当前可见」的数 —— 搜索把它一起收窄。 */
function FilterTabs({
  counts,
  filter,
  onFilter,
}: {
  readonly counts: { readonly all: number; readonly prs: number; readonly issues: number }
  readonly filter: PrFilter
  readonly onFilter: (filter: PrFilter) => void
}): ReactNode {
  return (
    <div className="mt-1.5 flex items-center gap-0.5">
      {FILTERS.map((tab) => {
        const active = tab.value === filter
        return (
          <button
            aria-label={`${tab.label}, ${String(counts[tab.value])}`}
            aria-pressed={active}
            className={cn(
              'flex h-5  items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors',
              active ? 'bg-foreground/[0.09] text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.05]',
            )}
            key={tab.value}
            onClick={() => {
              onFilter(tab.value)
            }}
            type="button"
          >
            <span>{tab.label}</span>
            <span className="tabular-nums opacity-70">{counts[tab.value]}</span>
          </button>
        )
      })}
    </div>
  )
}

/*
 * 一行 PR：标题（最多两行），下面一行是状态字形 + 「作者 · 相对时间 · 仓库 #编号」。
 * 状态字形在 meta 行的行首（不是整行垂直居中）—— 照参考实现。
 */
function PullRow({
  entry,
  selected,
  tabbable,
  onPrefetch,
  onSelect,
  register,
}: {
  readonly entry: GithubPullSummary
  readonly selected: boolean
  readonly tabbable: boolean
  readonly onPrefetch: ((number: number | null) => void) | undefined
  readonly onSelect: (number: number) => void
  readonly register: (number: number, node: HTMLButtonElement | null) => void
}): ReactNode {
  const presentation = pullStatePresentation(entry)
  const Glyph = STATE_GLYPHS[presentation.glyph]
  return (
    <li>
      <button
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex w-full flex-col gap-1 rounded-lg py-2 pr-1 pl-3 text-left transition-colors',
          /* 选中 = 一层 7% 的前景墨（在 #181818 上读得出来），悬停更浅一档。 */
          selected ? 'bg-foreground/[0.07]' : 'hover:bg-foreground/[0.04]',
        )}
        onBlur={() => {
          onPrefetch?.(null)
        }}
        onClick={() => {
          onSelect(entry.number)
        }}
        onFocus={() => {
          onPrefetch?.(entry.number)
        }}
        onPointerEnter={() => {
          onPrefetch?.(entry.number)
        }}
        onPointerLeave={() => {
          onPrefetch?.(null)
        }}
        ref={(node) => {
          register(entry.number, node)
        }}
        tabIndex={tabbable ? 0 : -1}
        type="button"
      >
        <span className="line-clamp-2 text-sm font-medium">{entry.title}</span>
        {/* meta 行：状态字形 + 头像 + 作者 + 相对时间，编号推到最右 —— 都照参考实现。 */}
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Glyph aria-hidden className={presentation.className} />
          <Avatar login={entry.author} size="sm" url={entry.avatarUrl} />
          <span className="truncate">{entry.author}</span>
          <span aria-hidden>·</span>
          <span className=" tabular-nums">{relativeTime(entry.createdAt)}</span>
          <span className="ml-auto pl-1 tabular-nums opacity-80">#{entry.number}</span>
        </span>
      </button>
    </li>
  )
}

function EmptyList({ loading, query }: { readonly loading: boolean; readonly query: string }): ReactNode {
  if (loading) {
    return (
      <div aria-hidden className="flex flex-col gap-2 pt-2">
        {[0, 1, 2, 3, 4, 5, 6].map((row) => (
          <div className="pr-sidebar__skeleton" key={row} />
        ))}
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-12 text-center">
      <p className="text-sm font-medium">{query.trim() === '' ? 'No pull requests' : 'No matches'}</p>
      <p className="max-w-[16rem] text-xs opacity-50">
        {query.trim() === '' ? 'Pull requests from this repository will show up here.' : 'Nothing matches that search.'}
      </p>
    </div>
  )
}
