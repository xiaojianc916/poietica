import './assistant-threads.css'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  StateDot,
} from '@poietica/design-system'
import { AlarmClock, FolderClosed, FolderOpen, MoreHorizontal, PinOff, Trash2 } from 'lucide-react'
import type { RefObject } from 'react'
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import type { Thread } from '../../../contract'
import { byIsoDescending } from '../../shared/model/thread-order'
import { useHorizon, useNow } from '../../shared/primitives/clock'
import { ArchiveIcon, ChevronDownIcon, ComposeIcon, PinIcon } from '../../shared/primitives/icons'
import { AnimatedRows } from './animated-rows'
import { datedGroupsOf, instantsOf, nextChangeIn, paintedGroupsOf } from './relative-time'
import { ThreadDisclosure } from './thread-disclosure'
import type { ArchivedFilter } from './thread-view'
import { GROUP_BY, type GroupBy, shapeGroups } from './thread-view'
import { ThreadsHeader } from './threads-header'
import { useTitleMarquee } from './title-marquee'

/* 行必须是 memo，否则时钟每跳一次就重渲整张列表；新建交给工作台开或激活，不在库里先造一条没人说过话的会话。 */

export interface AssistantThreadSummary {
  readonly id: string
  readonly title: string
  /** ISO-8601。传时刻不传文案：只有持有时钟的这一层才算文案。 */
  readonly updatedAt: string
  readonly isMuted?: boolean
  readonly isPinned?: boolean
  /** 此刻在等人答的那一档；null / 缺席 = 没有待答交互。 */
  readonly pendingInteraction?: Thread['pendingInteraction']
  /** 跑完了、但人还没回来点开（绿点）；缺席 = 没有这条提醒。 */
  readonly isDoneUnread?: boolean
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
  /** 删除项目：移除记录与其中对话，不动磁盘目录。确认框由宿主负责。 */
  readonly onRemoveWorkspace?: ((workspaceId: string) => void) | undefined
  readonly onPin: (threadId: string, pinned: boolean) => void
  readonly onArchive?: (threadId: string) => void
}

const PLACEHOLDER_WIDTHS = ['72%', '54%', '64%', '46%']

/* 一组默认先画十条；之后每次再多画五条，展开到底给出「收起全部」。 */
const DEFAULT_VISIBLE = 10
const PAGE = 5

const NO_PAGES: ReadonlyMap<string, number> = new Map()

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

/* 带序号的名字拆两段：正文吃省略号，序号钉在末尾。ref 只指向真正会被裁的那一段 —— 横移时序号不跟着跑。 */
function ThreadTitle({
  title,
  titleRef,
}: {
  readonly title: string
  readonly titleRef: RefObject<HTMLSpanElement | null>
}) {
  const matched = TRAILING_ORDINAL.exec(title)
  const base = matched?.groups?.base
  const ordinal = matched?.groups?.ordinal

  if (base === undefined || ordinal === undefined) {
    return (
      <span className="assistant-thread__title" ref={titleRef}>
        {title}
      </span>
    )
  }

  return (
    <span className="assistant-thread__title" data-ordinal="true">
      <span className="assistant-thread__title-base" ref={titleRef}>
        {base}
      </span>
      <span className="assistant-thread__title-ordinal">{ordinal}</span>
    </span>
  )
}

type PendingKind = NonNullable<Thread['pendingInteraction']>

/*
 * 待答交互的措辞（DSH 的 status.waitingApproval / planReview / waitingAnswer 与三枚短标签）：
 * 完整说法进读屏与悬停，短标签替换行尾的相对时间 —— 一列行里哪个在等人，不该靠点颜色猜。
 */
const PENDING_LABEL: Readonly<Record<PendingKind, string>> = {
  approval: '等待审批',
  plan: '计划待审',
  question: '等待回答',
}

const PENDING_COMPACT: Readonly<Record<PendingKind, string>> = {
  approval: '待审批',
  plan: '计划待审',
  question: '待回答',
}

type LeadMark =
  | { readonly kind: 'pending'; readonly state: PendingKind }
  | { readonly kind: 'running' }
  | { readonly kind: 'done' }
  | { readonly kind: 'automation' }

/*
 * 行首那一格只画一枚记号，优先级照 DSH 的 sessionStatuses：待答交互 > 正在跑 > 跑完未看 > 来历。
 *
 * - 待答交互排在最前，是因为它是唯一「不处理就永远停在那里」的状态；运行中的环与它同时成立
 *   （state 是 awaiting，不是 idle），若先画环，等审批的那一行看起来与普通运行中一模一样；
 * - 绿点是「活干完了，你还没回来点开」：它只在没有活动时才有意义，所以排在运行环之后；
 * - 定时任务那一枚闹钟说的是来历，不是状态（R-16），所以排在最后。
 */
function leadMarkOf(
  fromAutomation: boolean,
  isRunning: boolean,
  isDoneUnread: boolean,
  pending: PendingKind | null | undefined,
): LeadMark | null {
  if (pending !== null && pending !== undefined) return { kind: 'pending', state: pending }
  if (isRunning) return { kind: 'running' }
  if (isDoneUnread) return { kind: 'done' }
  if (fromAutomation) return { kind: 'automation' }
  return null
}

function ThreadLead({
  fromAutomation,
  isRunning,
  isDoneUnread,
  pending,
}: {
  readonly fromAutomation: boolean
  readonly isRunning: boolean
  readonly isDoneUnread: boolean
  readonly pending: PendingKind | null | undefined
}) {
  const mark = leadMarkOf(fromAutomation, isRunning, isDoneUnread, pending)

  if (mark === null) return null
  if (mark.kind === 'automation') {
    return <AlarmClock aria-label="定时任务" className="assistant-thread__origin" role="img" />
  }
  if (mark.kind === 'running') {
    return (
      <>
        <StateDot className="assistant-thread__status" state="ongoing" />
        <span className="assistant-thread__a11y">进行中</span>
      </>
    )
  }
  if (mark.kind === 'done') {
    return (
      <>
        <StateDot className="assistant-thread__status" state="done" />
        <span className="assistant-thread__a11y">已完成，尚未查看</span>
      </>
    )
  }
  return <StateDot className="assistant-thread__status" state="warning" />
}

interface ThreadRowProps {
  readonly thread: AssistantThreadSummary
  /** 已经算好的相对文案；无法解析的时刻是 null。 */
  readonly elapsed: string | null
  /** 同一时刻的准确说法，给悬停与读屏。 */
  readonly absolute: string | null
  readonly isActive: boolean
  readonly isRunning: boolean
  readonly isDoneUnread: boolean
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
  isDoneUnread,
  onActivate,
  onPin,
  onArchive,
}: ThreadRowProps) {
  const isPinned = thread.isPinned === true
  const pinLabel = isPinned ? '取消固定' : '固定'
  const titleRef = useRef<HTMLSpanElement>(null)
  const marquee = useTitleMarquee(titleRef)

  const togglePin = () => {
    onPin(thread.id, !isPinned)
  }

  return (
    <li
      className="assistant-thread"
      data-active={isActive ? 'true' : undefined}
      data-muted={thread.isMuted === true ? 'true' : undefined}
      data-row-key={`thread:${thread.id}`}
      onPointerEnter={marquee.enter}
      onPointerLeave={marquee.leave}
    >
      <ThreadLead
        fromAutomation={thread.record?.origin === 'automation'}
        isDoneUnread={isDoneUnread}
        isRunning={isRunning}
        pending={thread.pendingInteraction ?? null}
      />

      {/* 完整状态说法给读屏与悬停：行尾那一句是短标签，说得出「哪个在等人」，说不全「等什么」。 */}
      {thread.pendingInteraction === null || thread.pendingInteraction === undefined ? null : (
        <span className="assistant-thread__a11y">{PENDING_LABEL[thread.pendingInteraction]}</span>
      )}

      <button
        aria-busy={isRunning}
        className="assistant-thread__open"
        onClick={() => {
          onActivate(thread.id)
        }}
        type="button"
      >
        <ThreadTitle title={thread.title} titleRef={titleRef} />
      </button>

      {/* 时间与操作共用这一个格子，谁可见由同一条规则决定。 */}
      <span className="assistant-thread__trail">
        {/*
         * 待答交互时行尾不报时间，改报**短标签**（DSH 的做法）：一列行里「谁在等人」比「什么时候动过」
         * 更急需被看见，而完整说法已经在行首那枚点旁边给读屏了。悬停仍拿得到准确时刻。
         */}
        {thread.pendingInteraction !== null && thread.pendingInteraction !== undefined ? (
          <span aria-hidden="true" className="assistant-thread__pending" title={absolute ?? undefined}>
            {PENDING_COMPACT[thread.pendingInteraction]}
          </span>
        ) : elapsed === null ? null : (
          /* <time> 而非 <span>：读屏与悬停要拿得到准确时刻。 */
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
  readonly onRemove?: ((workspaceId: string) => void) | undefined
}

/* 组头是这一列里的另一行。不数条数；收与展往上报，不就地写一份全局状态。 */
function WorkspaceHeader({ workspaceId, name, isOpen, onCreate, onToggle, onRemove }: WorkspaceHeaderProps) {
  const createLabel = `在${name}中新建对话`
  const Glyph = isOpen ? FolderOpen : FolderClosed

  return (
    <div className="assistant-threads__group-header" data-row-key={`workspace:${workspaceId}`}>
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

      {onRemove === undefined ? null : (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger aria-label={`项目操作：${name}`} className="assistant-threads__create">
            <MoreHorizontal aria-hidden="true" />
          </DropdownMenuTrigger>

          <DropdownMenuContent
            align="end"
            className="assistant-thread-menu"
            data-assistant-skin
            side="bottom"
            sideOffset={6}
          >
            <DropdownMenuItem
              className="assistant-thread-menu__item"
              danger
              onClick={() => {
                onRemove(workspaceId)
              }}
            >
              <Trash2 aria-hidden="true" />

              <span>删除项目</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
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
  onRemoveWorkspace,
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

  /*
   * 所有对话都属于某个项目：没有「无项目」那一组，项目名单就是全部。
   * 空项目也保留（用户 2026-10-20）：还没有对话的项目同样要出现在侧栏，
   * 这样才有地方重命名、删除它，也能看见它确实被加进来了。
   */
  const repositories = useMemo(
    () =>
      painted.map((group) => ({
        ...group,
        members: group.members.filter(({ thread }) => !thread.isPinned),
      })),
    [painted],
  )

  /* 期限与分组维度无关，所以只认一串解析好的时刻。 */
  const instants = useMemo(() => instantsOf(dated), [dated])

  useHorizon(nextChangeIn(instants, now))

  const [isPinOpen, setPinOpen] = useState(true)
  const [isRepositoriesOpen, setRepositoriesOpen] = useState(true)

  /* 只活本次会话故不落盘；要活过重启的收起状态由宿主传。 */
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(NO_PAGES)

  /* 补间要量滚动盒在视口里的位置，退场影子也按它算坐标（它同时是这个列表的定位祖先，见 assistant-threads.css）。 */
  const scrollRef = useRef<HTMLElement>(null)

  const showMore = useCallback((workspaceId: string) => {
    setShown((held) => new Map(held).set(workspaceId, (held.get(workspaceId) ?? DEFAULT_VISIBLE) + PAGE))
  }, [])

  /* 收起只把这一组丢回默认十条，不动别的组已经展开的部分。 */
  const collapseAll = useCallback((workspaceId: string) => {
    setShown((held) => {
      if (!held.has(workspaceId)) return held

      const next = new Map(held)
      next.delete(workspaceId)
      return next
    })
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
      isDoneUnread={thread.isDoneUnread === true}
      isRunning={runningThreadIds.has(thread.id)}
      key={thread.id}
      onActivate={onActivate}
      onArchive={onArchive}
      onPin={onPin}
      thread={thread}
    />
  )

  /*
   * 补间的启用条件（正本 AnimatedRows 的 ready / resetKey / rowKeys 三条）。
   *
   * - ready：读取落定、占位骨架已撤。首屏那一批不该一行一行地淡进来。
   * - resetKey：这几种变化是「换一份视图」而不是「同一份视图里多/少一条」，补间只会读成抖动 ——
   *   搜索词、分组方式、归档筛选、展开其余、收起全部、收起某个项目。任一项换值即立即落定。
   * - rowKeys：按 DOM 顺序摊平所有带 data-row-key 的行。键序列没变，一个矩形都不量。
   */
  const animatedReady = !showPlaceholders && notice === null
  const animationResetKey = [
    archivedFilter,
    groupBy,
    query,
    String(isPinOpen),
    String(isRepositoriesOpen),
    [...collapsedWorkspaces].sort().join(','),
    [...shown.entries()]
      .map(([id, limit]) => `${id}:${String(limit)}`)
      .sort()
      .join(','),
  ].join('|')

  const rowKeys = [
    ...(pinned.length === 0 ? [] : pinned.map(({ thread }) => `thread:${thread.id}`)),
    ...repositories.flatMap((group) => [
      ...(group.name === null ? [] : [`workspace:${group.id}`]),
      ...group.members.slice(0, shown.get(group.id) ?? DEFAULT_VISIBLE).map(({ thread }) => `thread:${thread.id}`),
    ]),
  ]

  return (
    <nav aria-label="AI 会话记录" className="assistant-threads" data-assistant-skin ref={scrollRef}>
      <AnimatedRows ready={animatedReady} resetKey={animationResetKey} rowKeys={rowKeys} scroller={scrollRef} />
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
            const limit = shown.get(group.id) ?? DEFAULT_VISIBLE
            const members = group.members.slice(0, limit)
            const rest = group.members.length - members.length
            const canCollapse = rest === 0 && group.members.length > DEFAULT_VISIBLE

            return (
              <section className="assistant-threads__group" key={group.id}>
                {named === null ? null : (
                  <WorkspaceHeader
                    isOpen={isOpen}
                    name={named}
                    onCreate={onCreate}
                    onRemove={onRemoveWorkspace}
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
                      展开其余 {rest} 个会话
                    </button>
                  ) : canCollapse ? (
                    <button
                      className="assistant-threads__more"
                      onClick={() => {
                        collapseAll(group.id)
                      }}
                      type="button"
                    >
                      收起全部
                    </button>
                  ) : null}
                </ThreadDisclosure>
              </section>
            )
          })}
        </ThreadDisclosure>
      </section>
    </nav>
  )
}
