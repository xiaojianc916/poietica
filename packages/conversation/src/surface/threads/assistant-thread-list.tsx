import './assistant-threads.css'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  PixelLoader,
} from '@poietica/design-system'
import { Download, Pencil as Edit, FolderClosed, FolderOpen, PinOff, Share2 } from 'lucide-react'
import { Fragment, memo, useCallback, useMemo, useRef, useState } from 'react'
import { byIsoDescending } from '../../threads/thread-order'
import { useHorizon, useNow } from '../primitives/clock'
import {
  ArchiveIcon,
  ChevronDownIcon,
  MoreIcon,
  PinIcon,
  PlusIcon,
  SpinnerIcon,
} from '../primitives/icons'
import { datedGroupsOf, instantsOf, nextChangeIn, paintedGroupsOf } from './relative-time'
import { ThreadDisclosure } from './thread-disclosure'

/*
 * 会话列表。一级索引是工作区，不是时间桶 —— 分组判据与算法在 threads/thread-order，这里只画。
 * 收起的工作区是跨窗口、跨重启的宿主偏好，从 props 进来：展示组件绑死模块级可变状态，同屏画
 * 两次会互相打断；本层只留「每组展开到第几条」。加号不是记录：把「新建会话」交给工作台去开
 * 或激活，不在库里先造一条没人说过话的会话。菜单开合由 isMenuOpen 显式上报，不靠 CSS 嗅探
 * aria-expanded —— 它在关闭动画第一帧就落回 false，比弹层早一拍。不拆：行是 memo 组件、
 * 重命名草稿住行里，否则时钟每跳一次、每敲一个字都重渲整张列表。
 */

export interface AssistantThreadSummary {
  readonly id: string
  readonly title: string
  /** 最后一次活动的时刻，ISO-8601。传时刻不传文案：只有持有时钟的这一层才算文案。 */
  readonly updatedAt: string
  readonly isMuted?: boolean
  readonly isPinned?: boolean
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
  readonly onRename?: (threadId: string, title: string) => void
  readonly onExport?: (threadId: string) => void
  /** 点了就上传到第三方并换回一条链接：结果的提示由宿主给，必须说清楚会上传。 */
  readonly onShare?: (threadId: string) => void
  readonly onArchive?: (threadId: string) => void
  /** 正在上传的那条对话。上传要几秒，这一格必须给出「在跑」的样子。 */
  readonly share?: string | null
}

/** 行尾菜单里的一项。菜单本身 Portal 到 body，所以「有哪几项」这个判据落在这里才测得动。 */
export interface ThreadMenuEntry {
  readonly id: 'pin' | 'rename' | 'share' | 'export'
  readonly label: string
}

/*
 * 这一行画得出来的菜单项，次序就是判据：上传第三方（分享）排在本地导出之上 ——
 * 本地优先，先给不离开这台机器的那个。固定的文案随状态变，所以这里也叫 label 而不只是 id。
 *
 * 归档不在这张表里：它是行尾的一枚按钮（与固定并列的常用动作），不是菜单项。它只有一条
 * 判据、一个落点，所以判据直接写在使用处，不在这里再建一列。
 *
 * 为什么必须是它而不是几条并列的 JSX：菜单 Portal 到 body，静态渲染里一个字都看不见，
 * 而本仓没有真 DOM 测试基建 —— 判据不落在这里，「给不出就不画」这条就无从证明。别合回去。
 */
export function threadMenuEntries(input: {
  readonly isPinned: boolean
  readonly canRename: boolean
  readonly canShare: boolean
  readonly canExport: boolean
}): readonly ThreadMenuEntry[] {
  const entries: ThreadMenuEntry[] = [{ id: 'pin', label: input.isPinned ? '取消固定' : '固定' }]

  if (input.canRename) {
    entries.push({ id: 'rename', label: '重命名' })
  }
  if (input.canShare) {
    entries.push({ id: 'share', label: '分享' })
  }
  if (input.canExport) {
    entries.push({ id: 'export', label: '导出会话' })
  }

  return entries
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
    <span
      aria-hidden="true"
      className="assistant-thread__glyph"
      data-pinned={isPinned ? 'true' : undefined}
    >
      <Glyph aria-hidden="true" />
    </span>
  )
}

interface RenameFieldProps {
  readonly initial: string
  readonly onCommit: (title: string) => void
  readonly onCancel: () => void
}

/*
 * 重命名中的那一行。草稿住行里：此前住列表上，每敲一个字符整张列表重渲一次。
 * ref 用 useCallback 钉住标识：内联箭头每次渲染都是新函数，React 反复 detach 再 attach，
 * 每敲一个字符输入框就被全选一次，中间插不了字。挂载时只选中一次。
 */
function RenameField({ initial, onCommit, onCancel }: RenameFieldProps) {
  const [draft, setDraft] = useState(initial)

  const selectOnMount = useCallback((node: HTMLInputElement | null) => {
    node?.select()
  }, [])

  /*
   * 一次重命名只了结一次，闩属于「了结」而不属于某个结局：Enter 或 Escape 都会让输入框
   * 卸载、紧跟着派发一次 blur，而 blur 也接在这个出口上 —— 不闩就 rename 落两遍库（两次
   * 标题都非空，上层 trim 拦不住）；闩若只装提交那一路，Escape 卸载后的 blur 会把草稿当
   * 提交。两条出口共用，先到者说了算。去重放这层而非 store：只有这层知道出口通向同一次了结。
   */
  const settled = useRef(false)

  const finish = (outcome: 'cancel' | 'commit') => {
    if (settled.current) {
      return
    }

    settled.current = true

    if (outcome === 'commit') {
      onCommit(draft)
    } else {
      onCancel()
    }
  }

  return (
    <form
      className="assistant-thread__rename"
      onSubmit={(event) => {
        event.preventDefault()
        finish('commit')
      }}
    >
      <input
        aria-label="重命名会话"
        className="assistant-thread__rename-field"
        onBlur={() => {
          finish('commit')
        }}
        onChange={(event) => {
          setDraft(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            finish('cancel')
          }
        }}
        ref={selectOnMount}
        value={draft}
      />
    </form>
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
  const base = matched?.groups?.['base']
  const ordinal = matched?.groups?.['ordinal']

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

interface ThreadRowProps {
  readonly thread: AssistantThreadSummary
  /** 已经算好的相对文案；无法解析的时刻是 null。 */
  readonly elapsed: string | null
  /** 同一时刻的准确说法，给悬停与读屏。 */
  readonly absolute: string | null
  readonly isActive: boolean
  readonly isRunning: boolean
  readonly isRenaming: boolean
  /** 上层给不给重命名。给不了就不画那一项 —— 点了没反应的菜单项比不画更糟。 */
  readonly canRename: boolean
  readonly onActivate: (threadId: string) => void
  readonly onPin: (threadId: string, pinned: boolean) => void
  readonly onBeginRename: (threadId: string) => void
  readonly onCommitRename: (threadId: string, title: string) => void
  readonly onCancelRename: () => void
  readonly onExport?: ((threadId: string) => void) | undefined
  readonly onShare?: ((threadId: string) => void) | undefined
  readonly onArchive?: ((threadId: string) => void) | undefined
  /** 这一行正在上传，行尾给一个转圈。 */
  readonly isSharing: boolean
}

/* 固定的字形随状态变，不住这张表；其余一项一枚字形。 */
const MENU_GLYPHS = {
  rename: Edit,
  share: Share2,
  export: Download,
} as const

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
  isRenaming,
  canRename,
  onActivate,
  onPin,
  onBeginRename,
  onCommitRename,
  onCancelRename,
  onExport,
  onShare,
  onArchive,
  isSharing,
}: ThreadRowProps) {
  /*
   * 菜单开合是这一行的状态，受控：弹层 Portal 到 body，行的 :hover/:focus-within 够不着
   * 它，行尾那一格要在菜单打开期间保持显示操作。不靠 CSS 嗅探 aria-expanded —— 它在关闭
   * 动画开始时就落回 false，菜单还在屏上、图标已经灭了。open/onOpenChange 是 Base UI
   * Menu.Root 的一等能力（DropdownMenu 即其再导出），不是自造开关。
   */
  const [isMenuOpen, setIsMenuOpen] = useState(false)

  const isPinned = thread.isPinned === true
  const pinLabel = isPinned ? '取消固定' : '固定'

  const togglePin = () => {
    onPin(thread.id, !isPinned)
  }

  const entries = threadMenuEntries({
    isPinned,
    canRename,
    /* 给不出就地发起的动作就不画那一项：点了没反应的菜单项比不画更糟。 */
    canShare: onShare !== undefined,
    canExport: onExport !== undefined,
  })

  /*
   * 逐项取出它自己的样子与动作。固定要读这一行的 pinned，重命名走行自己的内联编辑入口，
   * 其余两项就是上层给的那两个回调 —— 都在这一处落定，别处不再判一次「有没有」。
   */
  const menuItemOf = (entry: ThreadMenuEntry) => {
    switch (entry.id) {
      case 'pin':
        return { Glyph: () => <PinGlyph isPinned={isPinned} />, run: togglePin }
      case 'rename':
        return { Glyph: MENU_GLYPHS.rename, run: () => onBeginRename(thread.id) }
      case 'share':
        return { Glyph: MENU_GLYPHS.share, run: () => onShare?.(thread.id) }
      case 'export':
        return { Glyph: MENU_GLYPHS.export, run: () => onExport?.(thread.id) }
    }
  }

  return (
    <li
      className="assistant-thread"
      data-active={isActive ? 'true' : undefined}
      data-menu-open={isMenuOpen ? 'true' : undefined}
      data-muted={thread.isMuted === true ? 'true' : undefined}
      data-renaming={isRenaming ? 'true' : undefined}
    >
      {isRunning ? <PixelLoader className="assistant-thread__running" /> : null}

      {isRenaming ? (
        <RenameField
          initial={thread.title}
          onCancel={onCancelRename}
          onCommit={(title) => {
            onCommitRename(thread.id, title)
          }}
        />
      ) : (
        <>
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
              <time
                className="assistant-thread__time"
                dateTime={thread.updatedAt}
                title={absolute ?? undefined}
              >
                {elapsed}
              </time>
            )}

            <span className="assistant-thread__actions">
              <button
                aria-label={pinLabel}
                className="assistant-thread__action"
                onClick={togglePin}
                type="button"
              >
                <PinGlyph isPinned={isPinned} />
              </button>

              {/* 归档与固定并列，不藏进菜单：给不出动作就不画。 */}
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

              {isSharing ? (
                <span
                  aria-label="正在上传到 my.omp.sh"
                  className="assistant-thread__sharing"
                  role="status"
                >
                  <SpinnerIcon aria-hidden="true" />
                </span>
              ) : null}

              {/*
                  Not modal: a modal menu locks pointer events outside itself, so the
                  click that dismissed it was swallowed instead of landing on the
                  row it was aimed at. 受控：开合状态上报给行，行底色与行尾格子据此保持。
                */}
              <DropdownMenu modal={false} onOpenChange={setIsMenuOpen} open={isMenuOpen}>
                <DropdownMenuTrigger aria-label="更多操作" className="assistant-thread__action">
                  <MoreIcon aria-hidden="true" />
                </DropdownMenuTrigger>

                {/*
                    DropdownMenuContent renders through a Portal; reapply the AI skin
                    at this DOM boundary so the --cp-* tokens survive leaving the
                    sidebar subtree.
                  */}
                <DropdownMenuContent
                  align="end"
                  className="assistant-thread-menu assistant-menu-surface"
                  data-assistant-skin
                  side="bottom"
                  sideOffset={4}
                >
                  {entries.map((entry) => {
                    const { Glyph, run } = menuItemOf(entry)

                    return (
                      <Fragment key={entry.id}>
                        <DropdownMenuItem className="assistant-thread-menu__item" onClick={run}>
                          <Glyph aria-hidden="true" />
                          <span>{entry.label}</span>
                        </DropdownMenuItem>
                      </Fragment>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </span>
        </>
      )}
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
    <button
      aria-expanded={isOpen}
      className="assistant-threads__section-title"
      onClick={onToggle}
      type="button"
    >
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
  onRename,
  onExport,
  onShare,
  onArchive,
  share,
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
  const [renamingId, setRenamingId] = useState<string | null>(null)

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

  const beginRename = useCallback((threadId: string) => {
    setRenamingId(threadId)
  }, [])

  const cancelRename = useCallback(() => {
    setRenamingId(null)
  }, [])

  /* 提交只走这一条路：Enter 与失焦都到这里，空标题等于放弃。 */
  const commitRename = useCallback(
    (threadId: string, title: string) => {
      setRenamingId(null)

      const next = title.trim()

      if (next.length > 0) {
        onRename?.(threadId, next)
      }
    },
    [onRename],
  )

  type PaintedThread = (typeof pinned)[number]

  const renderThread = ({ absolute, elapsed, thread }: PaintedThread) => (
    <ThreadRow
      absolute={absolute}
      canRename={onRename !== undefined}
      elapsed={elapsed}
      isActive={thread.id === activeThreadId}
      isRenaming={thread.id === renamingId}
      isRunning={runningThreadIds.has(thread.id)}
      isSharing={share === thread.id}
      key={thread.id}
      onActivate={onActivate}
      onArchive={onArchive}
      onBeginRename={beginRename}
      onCancelRename={cancelRename}
      onCommitRename={commitRename}
      onExport={onExport}
      onPin={onPin}
      onShare={onShare}
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
