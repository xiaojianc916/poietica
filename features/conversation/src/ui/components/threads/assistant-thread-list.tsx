import './assistant-threads.css'

import { PixelLoader } from '@poietica/design-system'
import { AlarmClock, FolderClosed, FolderOpen, PinOff } from 'lucide-react'
import { memo, useCallback, useMemo, useState } from 'react'
import type { Thread } from '../../../contract'
import { byIsoDescending } from '../../threads/thread-order'
import { useHorizon, useNow } from '../primitives/clock'
import { ArchiveIcon, ChevronDownIcon, ComposeIcon, PinIcon } from '../primitives/icons'
import { datedGroupsOf, instantsOf, nextChangeIn, paintedGroupsOf } from './relative-time'
import { ThreadDisclosure } from './thread-disclosure'
import type { ArchivedFilter } from './thread-view'
import { GROUP_BY, type GroupBy, shapeGroups } from './thread-view'
import { ThreadsHeader } from './threads-header'

/* 行必须是 memo，否则时钟每跳一次就重渲整张列表；新建交给工作台开或激活，不在库里先造一条没人说过话的会话。 */

export interface AssistantThreadSummary {
  readonly id: string
  readonly title: string
  /** ISO-8601。传时刻不传文案：只有持有时钟的这一层才算文案。 */
  readonly updatedAt: string
  readonly isMuted?: boolean
  readonly isPinned?: boolean
  readonly record?: Thread
}

export interface AssistantThreadWorkspaceGroup {
  readonly id: string
  /** null = 目录还没被记下来，这一组不画组头。 */
  readonly name: string | null
  readonly items: readonly AssistantThreadSummary[]
}

export interface AssistantThreadListProps {
  readonly groups: readonly AssistantThreadWorkspaceGroup[]
  readonly projectlessWorkspaces?: ReadonlySet<string>
  readonly isLoading?: boolean
  /** 空列表与读失败不能共用一句「还没有对话」。 */
  readonly failure?: string | null
  readonly activeThreadId: string | null
  readonly runningThreadIds: ReadonlySet<string>
  /** 收起状态活过重启，所以在宿主。 */
  readonly collapsedWorkspaces: ReadonlySet<string>
  readonly onToggleWorkspace: (workspaceId: string) => void
  /** 开系统的文件夹选择器，并把它加成一个工作区（组头右侧那枚加号与「新建项目」同一件事）。 */
  readonly onAddWorkspace: () => void
  /* 归档那一档要**换一次查询**（列表那一问带 includeArchived），所以它活在宿主，不在这层的草稿里。 */
  readonly archivedFilter: ArchivedFilter
  readonly onArchivedFilterChange: (value: ArchivedFilter) => void
  readonly onActivate: (threadId: string) => void
  readonly onCreate: (workspaceId?: string) => void
  readonly onPin: (threadId: string, pinned: boolean) => void
  readonly onArchive?: (threadId: string) => void
}

const PLACEHOLDER_WIDTHS = ['72%', '54%', '64%', '46%']

/* 一组先画多少条：几百条一次全画会把其余工作区推出屏幕，所以给「更多」增量展开而非分页。 */
const PAGE = 10

const NO_PAGES: ReadonlyMap<string, number> = new Map()

const NO_PROJECTLESS_WORKSPACES: ReadonlySet<string> = new Set()

/** 只有读成功才说得出口的「读完了，确实没有」。 */
const EMPTY = ''

/* 读失败此前也落在「还没有对话」上，那是只有读成功才成立的断言。 */
function noticeOf(failure: string | null | undefined, count: number): string | null {
  if (failure !== null && failure !== undefined) {
    return failure
  }

  return count === 0 ? EMPTY : null
}

/* 已固定画实心图钉、未固定画线稿：同族字形，语义由填充承担。 */
function PinGlyph({ isPinned }: { readonly isPinned: boolean }) {
  const Glyph = isPinned ? PinOff : PinIcon

  return (
    <span aria-hidden="true" className="assistant-thread__glyph" data-pinned={isPinned ? 'true' : undefined}>
      <Glyph aria-hidden="true" />
    </span>
  )
}

/** 结尾的分叉序号，例如 (2)。 */
const TRAILING_ORDINAL = /^(?<base>.*)(?<ordinal>\(\d+\))$/su

/* 带序号的名字拆两段：正文吃省略号，序号钉在末尾。 */
function ThreadTitle({ title }: { readonly title: string }) {
  const matched = TRAILING_ORDINAL.exec(title)
  const base = matched?.groups?.base
  const ordinal = matched?.groups?.ordinal

  if (base === undefined || ordinal === undefined) {
    return <span className="assistant-thread__title">{title}</span>
  }

  return (
    <span className="assistant-thread__title" data-ordinal="true">
      <span className="assistant-thread__title-base">{base}</span>
      <span className="assistant-thread__title-ordinal">{ordinal}</span>
    </span>
  )
}

/* 行首那一格：运行中让给加载指示 —— 闹钟说的是来历，不是状态（R-16）。 */
function ThreadLead({ fromAutomation, isRunning }: { readonly fromAutomation: boolean; readonly isRunning: boolean }) {
  if (isRunning) return <PixelLoader className="assistant-thread__running" />
  if (fromAutomation) return <AlarmClock aria-label="定时任务" className="assistant-thread__origin" role="img" />
  return null
}

interface ThreadRowProps {
  readonly thread: AssistantThreadSummary
  /** 已经算好的相对文案；无法解析的时刻是 null。 */
  readonly elapsed: string | null
  /** 同一时刻的准确说法，给悬停与读屏。 */
  readonly absolute: string | null
  readonly isActive: boolean
  readonly isRunning: boolean
  readonly onActivate: (threadId: string) => void
  readonly onPin: (threadId: string, pinned: boolean) => void
  readonly onArchive?: ((threadId: string) => void) | undefined
}

/* 时间以字符串而非对象进来：对象每次都是新引用，memo 次次落空。 */
const ThreadRow = memo(function ThreadRow({
  thread,
  elapsed,
  absolute,
  isActive,
  isRunning,
  onActivate,
  onPin,
  onArchive,
}: ThreadRowProps) {
  const isPinned = thread.isPinned === true
  const pinLabel = isPinned ? '取消固定' : '固定'

  const togglePin = () => {
    onPin(thread.id, !isPinned)
  }

  return (
    <li
      className="assistant-thread"
      data-active={isActive ? 'true' : undefined}
      data-muted={thread.isMuted === true ? 'true' : undefined}
    >
      <ThreadLead fromAutomation={thread.record?.origin === 'automation'} isRunning={isRunning} />

      <button
        aria-busy={isRunning}
        className="assistant-thread__open"
        onClick={() => {
          onActivate(thread.id)
        }}
        type="button"
      >
        <ThreadTitle title={thread.title} />
      </button>

      {/* 时间与操作共用这一个格子，谁可见由同一条规则决定。 */}
      <span className="assistant-thread__trail">
        {/* <time> 而非 <span>：读屏与悬停要拿得到准确时刻。 */}
        {elapsed === null ? null : (
          <time className="assistant-thread__time" dateTime={thread.updatedAt} title={absolute ?? undefined}>
            {elapsed}
          </time>
        )}

        <span className="assistant-thread__actions">
          <button aria-label={pinLabel} className="assistant-thread__action" onClick={togglePin} type="button">
            <PinGlyph isPinned={isPinned} />
          </button>

          {/* 给不出动作就不画。 */}
          {onArchive === undefined ? null : (
            <button
              aria-label="归档"
              className="assistant-thread__action"
              onClick={() => {
                onArchive(thread.id)
              }}
              type="button"
            >
              <ArchiveIcon aria-hidden="true" />
            </button>
          )}
        </span>
      </span>
    </li>
  )
})

interface WorkspaceHeaderProps {
  readonly workspaceId: string
  readonly name: string
  readonly isOpen: boolean
  readonly onCreate: (workspaceId?: string) => void
  readonly onToggle: (workspaceId: string) => void
}

/* 组头是这一列里的另一行。不数条数；收与展往上报，不就地写一份全局状态。 */
function WorkspaceHeader({ workspaceId, name, isOpen, onCreate, onToggle }: WorkspaceHeaderProps) {
  const createLabel = `在${name}中新建对话`
  const Glyph = isOpen ? FolderOpen : FolderClosed

  return (
    <div className="assistant-threads__group-header">
      <button
        aria-expanded={isOpen}
        className="assistant-threads__toggle"
        onClick={() => {
          onToggle(workspaceId)
        }}
        type="button"
      >
        <Glyph aria-hidden="true" className="assistant-threads__folder" />

        <span className="assistant-threads__name">{name}</span>
      </button>

      <button
        aria-label={createLabel}
        className="assistant-threads__create"
        onClick={() => {
          onCreate(workspaceId)
        }}
        type="button"
      >
        <ComposeIcon aria-hidden="true" />
      </button>
    </div>
  )
}

interface ThreadSectionHeaderProps {
  readonly label: string
  readonly isOpen: boolean
  readonly onToggle: () => void
}

function ThreadSectionHeader({ label, isOpen, onToggle }: ThreadSectionHeaderProps) {
  return (
    <button aria-expanded={isOpen} className="assistant-threads__section-title" onClick={onToggle} type="button">
      <span>{label}</span>

      <ChevronDownIcon aria-hidden="true" className="assistant-threads__section-chevron" />
    </button>
  )
}

export function AssistantThreadList({
  groups,
  projectlessWorkspaces = NO_PROJECTLESS_WORKSPACES,
  isLoading,
  failure,
  activeThreadId,
  runningThreadIds,
  collapsedWorkspaces,
  onAddWorkspace,
  archivedFilter,
  onArchivedFilterChange,
  onToggleWorkspace,
  onActivate,
  onCreate,
  onPin,
  onArchive,
}: AssistantThreadListProps) {
  /* 时钟整张列表共用，睡到下一次会变的时刻，不轮询。 */
  const now = useNow()

  /* 搜索词与分组方式只活在这一列（正本同样不落盘，本仓也没有对应的一份，另存就是第二个真相）；归档那一档要换查询，归宿主。 */
  const [query, setQuery] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>(GROUP_BY.workspace)
  /* 搜索展开时同一栏上的标题与另两枚动作一起让位（正本 sectionHeader），所以展开态由这一栏的两个孩子共用。 */
  const [searchOpen, setSearchOpen] = useState(false)

  /* 归档事实来自行自己的记录：`archived` 这一档要能筛，就不能只当它是「宿主已经帮我滤掉了」。 */
  const shaped = useMemo(
    () =>
      shapeGroups(
        groups.map((group) => ({
          id: group.id,
          name: group.name,
          items: group.items.map((item) => ({ ...item, archived: item.record?.archived === true })),
        })),
        { archivedFilter, groupBy, query },
      ),
    [archivedFilter, groupBy, groups, query],
  )

  const dated = useMemo(() => datedGroupsOf(shaped), [shaped])
  const painted = useMemo(() => paintedGroupsOf(dated, now), [dated, now])

  /* 固定是独立顶层入口，跨工作区按最近活动统一排序；项目列表保留工作区顺序。 */
  const pinned = useMemo(
    () =>
      painted
        .flatMap((group) => group.members)
        .filter(({ thread }) => thread.isPinned)
        .sort((left, right) => byIsoDescending(left.thread.updatedAt, right.thread.updatedAt)),
    [painted],
  )

  const recent = useMemo(
    () =>
      painted
        .filter((group) => projectlessWorkspaces.has(group.id))
        .flatMap((group) => group.members)
        .filter(({ thread }) => !thread.isPinned)
        .sort((left, right) => byIsoDescending(left.thread.updatedAt, right.thread.updatedAt)),
    [painted, projectlessWorkspaces],
  )

  const repositories = useMemo(
    () =>
      painted
        .filter((group) => !projectlessWorkspaces.has(group.id))
        .map((group) => ({
          ...group,
          members: group.members.filter(({ thread }) => !thread.isPinned),
        }))
        .filter((group) => group.members.length > 0),
    [painted, projectlessWorkspaces],
  )

  /* 期限与分组维度无关，所以只认一串解析好的时刻。 */
  const instants = useMemo(() => instantsOf(dated), [dated])

  useHorizon(nextChangeIn(instants, now))

  const [isPinOpen, setPinOpen] = useState(true)
  const [isRecentOpen, setRecentOpen] = useState(true)
  const [isRepositoriesOpen, setRepositoriesOpen] = useState(true)

  /* 只活本次会话故不落盘；要活过重启的收起状态由宿主传。 */
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(NO_PAGES)

  const showMore = useCallback((workspaceId: string) => {
    setShown((held) => new Map(held).set(workspaceId, (held.get(workspaceId) ?? PAGE) + PAGE))
  }, [])

  /* 首帧给行的形状不给结论：「还没有对话」只有读完才成立。 */
  const showPlaceholders = isLoading === true && groups.length === 0

  const notice = showPlaceholders ? null : noticeOf(failure, groups.length)

  type PaintedThread = (typeof pinned)[number]

  const renderThread = ({ absolute, elapsed, thread }: PaintedThread) => (
    <ThreadRow
      absolute={absolute}
      elapsed={elapsed}
      isActive={thread.id === activeThreadId}
      isRunning={runningThreadIds.has(thread.id)}
      key={thread.id}
      onActivate={onActivate}
      onArchive={onArchive}
      onPin={onPin}
      thread={thread}
    />
  )

  return (
    <nav aria-label="AI 会话记录" className="assistant-threads" data-assistant-skin>
      {pinned.length === 0 ? null : (
        <section className="assistant-threads__section">
          <ThreadSectionHeader
            isOpen={isPinOpen}
            label="置顶"
            onToggle={() => {
              setPinOpen((open) => !open)
            }}
          />

          <ThreadDisclosure isOpen={isPinOpen}>
            <ul className="assistant-threads__list">{pinned.map(renderThread)}</ul>
          </ThreadDisclosure>
        </section>
      )}

      <section className="assistant-threads__section">
        {/* 标题与那三枚按钮是同一条栏：搜索展开时标题让位，动作让位（正本 sectionHeader 的编排）。 */}
        <div className="assistant-threads__section-bar" data-searching={searchOpen ? 'true' : undefined}>
          <ThreadSectionHeader
            isOpen={isRepositoriesOpen}
            label="项目"
            onToggle={() => {
              setRepositoriesOpen((open) => !open)
            }}
          />

          <ThreadsHeader
            archivedFilter={archivedFilter}
            expanded={searchOpen}
            groupBy={groupBy}
            onAdd={onAddWorkspace}
            onArchivedFilterChange={onArchivedFilterChange}
            onExpandedChange={setSearchOpen}
            onGroupByChange={setGroupBy}
            onQueryChange={setQuery}
            query={query}
          />
        </div>

        <ThreadDisclosure isOpen={isRepositoriesOpen}>
          {showPlaceholders ? (
            <ul aria-hidden="true" className="assistant-threads__list">
              {PLACEHOLDER_WIDTHS.map((width) => (
                <li className="assistant-thread" data-placeholder="true" key={width}>
                  <span className="assistant-thread__ghost" style={{ width }} />
                </li>
              ))}
            </ul>
          ) : null}

          {notice === null ? null : <p className="assistant-threads__empty">{notice}</p>}

          {repositories.map((group) => {
            /* 名字缺席的组不长组头：编一个「默认工作区」是造一个用户问得出「在哪」而界面答不上的标题。无标题故也无折叠，收不起一个说不出名字的东西。 */
            const named = group.name
            const isOpen = named === null || !collapsedWorkspaces.has(group.id)
            const limit = shown.get(group.id) ?? PAGE
            const members = group.members.slice(0, limit)
            const rest = group.members.length - members.length

            return (
              <section className="assistant-threads__group" key={group.id}>
                {named === null ? null : (
                  <WorkspaceHeader
                    isOpen={isOpen}
                    name={named}
                    onCreate={onCreate}
                    onToggle={onToggleWorkspace}
                    workspaceId={group.id}
                  />
                )}

                <ThreadDisclosure isOpen={isOpen}>
                  <ul className="assistant-threads__list">{members.map(renderThread)}</ul>

                  {rest > 0 ? (
                    <button
                      className="assistant-threads__more"
                      onClick={() => {
                        showMore(group.id)
                      }}
                      type="button"
                    >
                      更多
                    </button>
                  ) : null}
                </ThreadDisclosure>
              </section>
            )
          })}
        </ThreadDisclosure>
      </section>

      {/* projectless conversations follow repositories */}
      {recent.length === 0 ? null : (
        <section className="assistant-threads__section">
          <ThreadSectionHeader
            isOpen={isRecentOpen}
            label="对话"
            onToggle={() => {
              setRecentOpen((open) => !open)
            }}
          />

          <ThreadDisclosure isOpen={isRecentOpen}>
            <ul className="assistant-threads__list">{recent.map(renderThread)}</ul>
          </ThreadDisclosure>
        </section>
      )}
    </nav>
  )
}
