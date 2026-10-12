import './assistant-threads.css'

import { PixelLoader } from '@poietica/design-system'
import { AlarmClock, FolderClosed, FolderOpen, PinOff } from 'lucide-react'
import { memo, useCallback, useMemo, useState } from 'react'
import type { Thread } from '../../../contract'
import { byIsoDescending } from '../../threads/thread-order'
import { useHorizon, useNow } from '../primitives/clock'
import { ArchiveIcon, ChevronDownIcon, PinIcon, PlusIcon } from '../primitives/icons'
import { datedGroupsOf, instantsOf, nextChangeIn, paintedGroupsOf } from './relative-time'
import { ThreadDisclosure } from './thread-disclosure'

/*
 * 会话列表。一级索引是工作区，不是时间桶 —— 分组判据与算法在 threads/thread-order，这里只画。
 * 收起的工作区是跨窗口、跨重启的宿主偏好，从 props 进来：展示组件绑死模块级可变状态，同屏画
 * 两次会互相打断；本层只留「每组展开到第几条」。加号不是记录：把「新建会话」交给工作台去开
 * 或激活，不在库里先造一条没人说过话的会话。行尾只留「固定」与「归档」两枚按钮：点开的那张
 * 菜单（连同就地改名）已经搬去会话页左上角的标题格（ThreadTitleMenu），这里不再有第二入口。
 * 不拆：行是 memo 组件，否则时钟每跳一次就重渲整张列表。
 */

export interface AssistantThreadSummary {
  readonly id: string
  readonly title: string
  /** 最后一次活动的时刻，ISO-8601。传时刻不传文案：只有持有时钟的这一层才算文案。 */
  readonly updatedAt: string
  readonly isMuted?: boolean
  readonly isPinned?: boolean
  /**
   * 平台上的整条记录。列表自身只需上面那几格，多要它一条只为行首那枚闹钟（origin）。
   */
  readonly record?: Thread
}

/** 一个工作区，以及它下面的对话。次序由上游定好，这一层不重排。 */
export interface AssistantThreadWorkspaceGroup {
  readonly id: string
  /** 叫什么，null 表示目录还没有被记下来 —— 这一组不画组头。 */
  readonly name: string | null
  readonly items: readonly AssistantThreadSummary[]
}

export interface AssistantThreadListProps {
  readonly groups: readonly AssistantThreadWorkspaceGroup[]
  /** 工作目录属于内部 projectless 命名空间的那些组。 */
  readonly projectlessWorkspaces?: ReadonlySet<string>
  /** True while the list is still being read for the first time. */
  readonly isLoading?: boolean
  /** 读不出来时的说法：空列表与读失败是两件事，不能共用一句「还没有对话」。 */
  readonly failure?: string | null
  readonly activeThreadId: string | null
  /** 正在跑的那些对话。行首那一格由它决定画不画。 */
  readonly runningThreadIds: ReadonlySet<string>
  /** 收起来的工作区，以及收起／展开它的动作。两者都要活过重启，所以住在宿主。 */
  readonly collapsedWorkspaces: ReadonlySet<string>
  readonly onToggleWorkspace: (workspaceId: string) => void
  readonly onActivate: (threadId: string) => void
  /** 不点名工作区就是「当前那个」，由宿主决定。 */
  readonly onCreate: (workspaceId?: string) => void
  readonly onPin: (threadId: string, pinned: boolean) => void
  /** 归档这一条对话。缺省（夹具、其它宿主）就不画那一枚按钮。 */
  readonly onArchive?: (threadId: string) => void
}

/** Widths that make the skeleton read as a list rather than as a bar. */
const PLACEHOLDER_WIDTHS = ['72%', '54%', '64%', '46%']

/*
 * 一组先画多少条。侧栏不是归档界面：几百条一次全画会把其余工作区推出屏幕，给「更多」
 * 增量展开而非分页 —— 这一列没有「第 2 页」的位置感。
 */
const PAGE = 10

const NO_PAGES: ReadonlyMap<string, number> = new Map()

const NO_PROJECTLESS_WORKSPACES: ReadonlySet<string> = new Set()

/** 读完了，确实没有。这句话只有读成功才说得出口。 */
const EMPTY = ''

/*
 * 列表本体之外那句话。三种处境互斥，读失败此前也落在「还没有对话」上 —— 那是只有读成功
 * 才成立的断言；失败文案由 store 给出（threads/thread-order 的 ThreadWorkspaceList）。
 */
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

/*
 * 带分叉序号的名字拆两段：正文吃省略号，序号钉在末尾。thread-title.ts 的宽度上限
 * 保证多数时候整串放得下，这里守侧栏更窄的时刻。
 */
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

/*
 * 行首那一格：运行中是加载指示；定时任务开的对话（本来空着的这一格）放一枚闹钟 ——
 * 它是来历，不是状态，所以运行中让给加载指示（审查 R-16）。
 */
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
  /** 这一行正在上传，行尾给一个转圈。 */
}

/*
 * 时间以两个字符串进来，不是对象：对象每次都是新引用，memo 次次落空；传字符串，
 * 时钟跳动时只有文案真变了的那几行重渲。
 */
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

      {/* 时间与操作共用这一个格子，谁可见由同一个判定决定。 */}
      <span className="assistant-thread__trail">
        {/* <time> 而非 <span>：读屏与悬停要拿得到准确时刻，相对文案只是它的近似说法。 */}
        {elapsed === null ? null : (
          <time className="assistant-thread__time" dateTime={thread.updatedAt} title={absolute ?? undefined}>
            {elapsed}
          </time>
        )}

        <span className="assistant-thread__actions">
          <button aria-label={pinLabel} className="assistant-thread__action" onClick={togglePin} type="button">
            <PinGlyph isPinned={isPinned} />
          </button>

          {/* 归档与固定并列，不再有「更多」：给不出动作就不画。 */}
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
  /** 这个工作区叫什么。没有名字的组不画组头，所以这里不接受 null。 */
  readonly name: string
  readonly isOpen: boolean
  readonly onCreate: (workspaceId?: string) => void
  readonly onToggle: (workspaceId: string) => void
}

/*
 * 工作区组头，就是这一列里的另一行：与会话行同高同缩进同悬停底色，说的只是「下面这张列表
 * 属于哪个目录」。开与合是两枚轮廓文件夹 —— 展开曾画实心，而实心已被图钉占用表示「已固定」，
 * 同一种填法不能说两件事；文件夹只属于组头，工作区与会话的层级不混淆。不数条数：没人问过
 * 条数，它只会让名字在数字变化时多抖一次。组头是按钮：aria-expanded 说的是下面那张列表在
 * 不在，收与展往上报，不就地写一份全局状态。
 */
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
        <PlusIcon aria-hidden="true" />
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
  onToggleWorkspace,
  onActivate,
  onCreate,
  onPin,
  onArchive,
}: AssistantThreadListProps) {
  /* 时钟进来一次整张列表共用，不各行读墙上时间；它睡到下一次会变的时刻，不轮询。 */
  const now = useNow()

  /* 两级投影：时刻与绝对文案只随数据变，相对文案才随时钟变。 */
  const dated = useMemo(() => datedGroupsOf(groups), [groups])
  const painted = useMemo(() => paintedGroupsOf(dated, now), [dated, now])

  /*
   * 固定是独立顶层入口，从已算好时间文案的投影里拆出，避免为同一行重复解析日期；
   * 固定列表跨工作区故按最近活动统一排序，Repositories 保留工作区顺序。
   */
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

  /* 期限从解析好的时刻上求 —— 它与分组维度无关，所以只认一串数字。 */
  const instants = useMemo(() => instantsOf(dated), [dated])

  useHorizon(nextChangeIn(instants, now))

  const [isPinOpen, setPinOpen] = useState(true)
  const [isRecentOpen, setRecentOpen] = useState(true)
  const [isRepositoriesOpen, setRepositoriesOpen] = useState(true)

  /*
   * 每组展开到第几条。放这层而非组头：map 里开不了 hook，且组身份随数据增删变化，
   * 状态跟着组件走会在重挂载时丢。只活本次会话故不落盘；要活过重启的收起状态由宿主传。
   */
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(NO_PAGES)

  const showMore = useCallback((workspaceId: string) => {
    setShown((held) => new Map(held).set(workspaceId, (held.get(workspaceId) ?? PAGE) + PAGE))
  }, [])

  /* 首帧给行的形状不给结论：「还没有对话」只有读完才成立，当加载态显示等于先说错话。 */
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
        <ThreadSectionHeader
          isOpen={isRepositoriesOpen}
          label="项目"
          onToggle={() => {
            setRepositoriesOpen((open) => !open)
          }}
        />

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
            /*
             * 名字缺席的组不长组头：缺席说的是「工作目录还没被记下来」，不是没有工作区 ——
             * 会话本来就对着目录开。编一个「默认工作区」是造一个用户问得出「在哪」而界面
             * 答不上的标题。于是按本来的样子画：无标题、无折叠（收不起一个说不出名字的
             * 东西）；原生侧把目录记下后自然长出名字与组头，这层不用再改。
             */
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
