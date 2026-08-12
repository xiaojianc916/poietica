import '../surface/assistant.css'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@poietica/ui'
import {
  Archive,
  Pencil as Edit,
  ExternalLink,
  FolderClosed,
  FolderOpen,
  GitFork,
  PinOff,
} from 'lucide-react'
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { ChevronDownIcon, MoreIcon, PinIcon, PlusIcon } from '../primitives/icons'
import { useHorizon, useNow } from './clock'
import { datedGroupsOf, instantsOf, nextChangeIn, paintedGroupsOf } from './relative-time'

/*
 * 会话列表。
 *
 * 一级索引是**工作区**。此前是时间桶（今天／昨天／过去 7 天／过去 30 天／更早）：
 * 那是个人聊天机器人的信息架构，它假设「什么时候说的」是找回一条对话的主线索。
 * 对着一个工作目录干活的 agent 客户端不是这样 —— 主线索是「在哪个项目里」，
 * 时间退回它本来的位置：行尾那一格的元数据。于是同一件事不再说两遍（组头写
 * 「昨天」、行尾又写「1天」）。
 *
 * 分组不在这一层算。它是次序规则的一部分，住在 agent-session 的 thread-order，
 * 与库那条 ORDER BY 同源；这一层只把分好的组画出来。
 *
 * 收起了哪些工作区也不由这一层持有：那是一份跨窗口、跨重启存活的宿主偏好，
 * 从 props 进来（collapsedWorkspaces / onToggleWorkspace）。展示组件绑死一份
 * 模块级可变状态的话，同一份界面在一个进程里画两次会互相打断，也没法在没有
 * Web Storage 的环境里渲染。这一层自己只留一件视图状态：每组已经展开到第几条。
 *
 * 一行是一个组件。此前整行——重命名表单、时间格、固定按钮、四项菜单——都摊在
 * 父组件 map 的匿名回调里，于是列表没有可比较的边界：时钟每跳一次、草稿每多
 * 一个字符，每一行连同它各自持有的菜单根都要重建一遍。列表类界面把行做成
 * 可比较的组件是通行做法，这里补上。
 *
 * 一行的尾部只有一个格子：时间与操作叠在同一个网格单元上，宽度取两者较大者，
 * 图标出现时标题不动。谁在画只由一件事决定 —— 这一行是否正被介入：指针在行
 * 上、键盘落在行内、或它自己的菜单开着。三者等价，汇成 CSS 里的一条判定。
 *
 * 菜单那一路由本组件持有的 isMenuOpen 显式上报，不再靠 CSS 去嗅探触发器身上
 * 的 aria-expanded：那个属性在关闭动画的第一帧就落回 false，比弹层早消失一拍。
 *
 * 加号是入口，不是记录：它把「新建会话」那一格交给工作台去开或去激活，
 * 不在数据库里先造一条没人说过话的会话。它只长在组头上 —— 面板顶那一栏是
 * 工作目录本身（WorkspacePicker），不是这张列表的标题，新建跟着工作区走。
 */

export interface AssistantThreadSummary {
  readonly id: string
  readonly title: string
  /**
   * 最后一次活动的时刻，ISO-8601。
   *
   * 传时刻而不是传算好的文案：文案随墙上时间变化，只有持有时钟的这一层
   * 才有资格算它。
   */
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
  /**
   * 读不出来时的说法。
   *
   * 空列表与读失败是两件事，此前它们画的是同一句「还没有对话」。
   */
  readonly failure?: string | null
  readonly activeThreadId: string | null
  /** 收起来的工作区，以及收起／展开它的动作。两者都要活过重启，所以住在宿主。 */
  readonly collapsedWorkspaces: ReadonlySet<string>
  readonly onToggleWorkspace: (workspaceId: string) => void
  readonly onActivate: (threadId: string) => void
  /** 不点名工作区就是「当前那个」，由宿主决定。 */
  readonly onCreate: (workspaceId?: string) => void
  readonly onPin: (threadId: string, pinned: boolean) => void
  readonly onRename?: (threadId: string, title: string) => void
  readonly onArchive?: (threadId: string) => void
  /** 从这条对话分叉出一条新对话，源对话不动。不给就没有这个菜单项。 */
  readonly onFork?: (threadId: string) => void
  readonly onOpenInNewTab?: (threadId: string) => void
}

/** Widths that make the skeleton read as a list rather than as a bar. */
const PLACEHOLDER_WIDTHS = ['72%', '54%', '64%', '46%']

/*
 * 一组先画多少条。
 *
 * 侧栏不是归档界面：一个长期用着的工作区能攒上几百条，一次全画出来只会把其余
 * 工作区推到屏幕之外。标杆客户端在这里给的是一枚「更多」，每按一次多给一页 ——
 * 增量展开，而不是分页跳转，因为这一列没有「第 2 页」这种位置感。
 */
const PAGE = 10

const NO_PAGES: ReadonlyMap<string, number> = new Map()

const NO_PROJECTLESS_WORKSPACES: ReadonlySet<string> = new Set()

/** 读完了，确实没有。这句话只有读成功才说得出口。 */
const EMPTY = '还没有对话。'

/*
 * 列表本体之外那一句话。
 *
 * 三种处境互斥，而此前只分了两种：还在读就画骨架，读完是空的就说「还没有对话」——
 * 读失败也落在同一句上。那是一个只有读成功才成立的断言，被用来报告读失败。而失败
 * 的说法一直是有的：store 算出 failure（agent-session 的 ThreadWorkspaceList），
 * 一路交到 useThreadsList，然后在侧栏被丢掉。这个文件自己的注释早写明了这条道理，
 * 只兑现了加载那一半。
 */
function noticeOf(failure: string | null | undefined, count: number): string | null {
  if (failure !== null && failure !== undefined) {
    return failure
  }

  return count === 0 ? EMPTY : null
}

/*
 * 固定与取消固定是同一枚图钉的两种填法。
 *
 * 图标库有 pin 的 solid 变体，于是「已固定」画实心图钉，「未固定」画线稿：
 * 同族字形、同一轮廓，语义由填充承担。
 */
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
 * 重命名中的那一行。
 *
 * 草稿住在这里，因为它是这一行的临时输入状态：此前它住在列表上，于是每敲
 * 一个字符整张列表连同每行的菜单根都要重渲一次。
 *
 * ref 用 useCallback 钉住标识。此前是内联箭头，每次渲染都是新函数，React
 * 因此每次都 detach 再 attach，于是每敲一个字符输入框就被整体全选一次——
 * 想在中间插字是插不进去的。挂载时选中一次，才是重命名该有的行为。
 */
function RenameField({ initial, onCommit, onCancel }: RenameFieldProps) {
  const [draft, setDraft] = useState(initial)

  const selectOnMount = useCallback((node: HTMLInputElement | null) => {
    node?.select()
  }, [])

  /*
   * 一次重命名只了结一次，而「了结」有两种结局。
   *
   * 闩防的是输入框的卸载，不是提交本身：无论 Enter 提交还是 Escape 放弃，
   * 这一行都会切回非重命名分支，输入框因此卸载，浏览器紧跟着派发一次 blur ——
   * 而 blur 也接在这个出口上。于是一次动作走两遍：rename 落两遍库、发两遍
   * 通知、列表刷两遍。上层那句 trim().length > 0 拦不住它，两次的标题一模
   * 一样，都非空。
   *
   * 闩此前只装在提交那一路。Escape 走 onCancel 卸载输入框，随后那次 blur
   * 落进未闩的 commit —— 按下取消，草稿被提交。取消键做了提交键的事，而
   * 这两条路径共用的那个前提（卸载会再派发一次 blur）就写在上面。
   *
   * 所以闩属于「这次重命名结束了」，不属于其中某一个结局。两条出口共用它，
   * 先到的那个说了算。去重放在这一层而不是 store 里：这一层知道这些出口
   * 通向同一次了结，store 不知道，它只会看到两条合法的重命名。
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

interface ThreadRowProps {
  readonly thread: AssistantThreadSummary
  /** 已经算好的相对文案；无法解析的时刻是 null。 */
  readonly elapsed: string | null
  /** 同一时刻的准确说法，给悬停与读屏。 */
  readonly absolute: string | null
  readonly isActive: boolean
  readonly isRenaming: boolean
  /** 上层给不给重命名这个能力。给不了就不画那一项 —— 画一个点了没反应的菜单项，
   * 比不画更糟：重命名那一项还会让人先敲完字，再把它静默丢掉。 */
  readonly canRename: boolean
  readonly onActivate: (threadId: string) => void
  readonly onPin: (threadId: string, pinned: boolean) => void
  readonly onBeginRename: (threadId: string) => void
  readonly onCommitRename: (threadId: string, title: string) => void
  readonly onCancelRename: () => void
  readonly onArchive?: ((threadId: string) => void) | undefined
  readonly onFork?: ((threadId: string) => void) | undefined
  readonly onOpenInNewTab?: ((threadId: string) => void) | undefined
}

/*
 * 时间以两个字符串进来，不是一个对象。
 *
 * 对象每次都是新引用，memo 会次次落空；传字符串，时钟跳动时只有文案真的
 * 变了的那几行才重渲——"3 天前"的行整晚不动。
 */
const ThreadRow = memo(function ThreadRow({
  thread,
  elapsed,
  absolute,
  isActive,
  isRenaming,
  canRename,
  onActivate,
  onPin,
  onBeginRename,
  onCommitRename,
  onCancelRename,
  onArchive,
  onFork,
  onOpenInNewTab,
}: ThreadRowProps) {
  /*
   * 菜单开合是这一行的状态，所以它住在这一行里。
   *
   * 受控而不是放任：行尾那一格要在菜单打开期间保持显示操作，而弹层是 Portal
   * 到 body 的 —— 行的 :hover 与 :focus-within 都够不着它。此前 CSS 去看触发器
   * 的 aria-expanded 来补这一段，但那个属性在关闭动画开始时就落回 false，菜单
   * 还在屏幕上，图标已经灭了、时间已经冒出来了。
   *
   * open / onOpenChange 是 Base UI Menu.Root 的一等能力（DropdownMenu 就是
   * Menu.Root 的再导出），不是这里自己造的开关。
   */
  const [isMenuOpen, setIsMenuOpen] = useState(false)

  const isPinned = thread.isPinned === true
  const pinLabel = isPinned ? '取消固定' : '固定'

  const togglePin = () => {
    onPin(thread.id, !isPinned)
  }

  return (
    <li
      className="assistant-thread"
      data-active={isActive ? 'true' : undefined}
      data-menu-open={isMenuOpen ? 'true' : undefined}
      data-muted={thread.isMuted === true ? 'true' : undefined}
      data-renaming={isRenaming ? 'true' : undefined}
    >
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
            className="assistant-thread__open"
            onClick={() => {
              onActivate(thread.id)
            }}
            type="button"
          >
            <span className="assistant-thread__title">{thread.title}</span>
          </button>

          {/* 时间与操作共用这一个格子，谁可见由同一个判定决定。 */}
          <span className="assistant-thread__trail">
            {/*
                <time> 而不是 <span>：这一格说的是一个时刻，读屏软件与悬停都
                应当拿得到准确值，相对文案只是它的近似说法。
              */}
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

              {/*
                  Not modal: a modal menu locks pointer events outside itself,
                  so the click that dismissed it was swallowed instead of
                  landing on the row it was aimed at.

                  受控：开合状态上报给这一行，行的底色与行尾那一格据此保持。
                */}
              <DropdownMenu modal={false} onOpenChange={setIsMenuOpen} open={isMenuOpen}>
                <DropdownMenuTrigger aria-label="更多操作" className="assistant-thread__action">
                  <MoreIcon aria-hidden="true" />
                </DropdownMenuTrigger>

                {/*
                    DropdownMenuContent is rendered through a Portal. Reapply
                    the AI skin at this DOM boundary so the --cp-* tokens
                    survive leaving the sidebar subtree.
                  */}
                <DropdownMenuContent
                  align="end"
                  className="assistant-thread-menu assistant-menu-surface"
                  data-assistant-skin
                  side="bottom"
                  sideOffset={4}
                >
                  <DropdownMenuItem className="assistant-thread-menu__item" onClick={togglePin}>
                    <PinGlyph isPinned={isPinned} />
                    <span>{pinLabel}</span>
                  </DropdownMenuItem>

                  {canRename ? (
                    <DropdownMenuItem
                      className="assistant-thread-menu__item"
                      onClick={() => {
                        onBeginRename(thread.id)
                      }}
                    >
                      <Edit aria-hidden="true" />
                      <span>重命名</span>
                    </DropdownMenuItem>
                  ) : null}
                  {onFork === undefined ? null : (
                    <DropdownMenuItem
                      className="assistant-thread-menu__item"
                      onClick={() => {
                        onFork(thread.id)
                      }}
                    >
                      <GitFork aria-hidden="true" />
                      <span>分叉对话</span>
                    </DropdownMenuItem>
                  )}

                  {onArchive === undefined ? null : (
                    <DropdownMenuItem
                      className="assistant-thread-menu__item assistant-thread-menu__item--destructive"
                      onClick={() => {
                        onArchive(thread.id)
                      }}
                    >
                      <Archive aria-hidden="true" />
                      <span>归档</span>
                    </DropdownMenuItem>
                  )}

                  {/* 分隔符属于它下面那一项：那一项不在，这条线也不该在。 */}
                  {onOpenInNewTab === undefined ? null : (
                    <>
                      <DropdownMenuSeparator className="assistant-thread-menu__separator" />

                      <DropdownMenuItem
                        className="assistant-thread-menu__item"
                        onClick={() => {
                          onOpenInNewTab(thread.id)
                        }}
                      >
                        <ExternalLink aria-hidden="true" />
                        <span>在新选项卡中打开</span>
                      </DropdownMenuItem>
                    </>
                  )}
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
 * 一个工作区的组头。
 *
 * 它就是这一列里的另一行：与会话行同高、同缩进、同圆角、同悬停底色，
 * 名字同字号同墨色。区别只在于它说的是「下面这张列表属于哪个目录」，
 * 而不是一条对话。此前它是另一套东西：12px 的手转箭头、micro 号灰色
 * 小字、行尾一枚计数 —— 三个数都来自「段标题」这个旧的自我定位，
 * 于是同一列上下两段各用一套尺子。
 *
 * 开与合是两枚文件夹，不是一枚箭头的两个角度，也不是一枚文件夹的两种
 * 填法：此前库里没有 folder-open，只好展开画实心 —— 而实心在这一列已被
 * 图钉占去表示「已固定」，同一种填法不能说两件事。现在两枚都是轮廓，几
 * 何取自 Lucide，住在设计系统的本地字形里。具体会话行不再绘制前导
 * message 图标；文件夹只属于工作区组头，工作区与会话的层级不会混淆。
 *
 * 不数条数：条数是一个没有人问过的问题，它占着行尾，只是让名字在
 * 数字变化时多抖一次。
 *
 * 组头是一个按钮，不是一行装饰文字：它要能收起这个工作区，所以
 * aria-expanded 说的是下面那张列表在不在，而不是它自己的样子。收与展
 * 是往上报的一件事，不是在这里就地去写一份全局状态 —— 这一格和它旁边
 * 那枚加号现在遵守同一条规矩。
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
      data-expanded={isOpen ? 'true' : 'false'}
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
  collapsedWorkspaces,
  onToggleWorkspace,
  onActivate,
  onCreate,
  onPin,
  onRename,
  onArchive,
  onFork,
  onOpenInNewTab,
}: AssistantThreadListProps) {
  /*
   * 时钟在这里进来一次，整张列表共用；每行不再各自读一次墙上时间。
   *
   * 同时告诉它这一屏下一次会变的时刻：它不按拍子轮询，睡到那一刻为止。
   */
  const now = useNow()

  /* 两级投影：时刻与绝对文案只随数据变，相对文案才随时钟变。 */
  const dated = useMemo(() => datedGroupsOf(groups), [groups])
  const painted = useMemo(() => paintedGroupsOf(dated, now), [dated, now])

  /*
   * 固定是一个独立的顶层入口，不再同时留在工作区下面。
   *
   * 从已经算好时间文案的投影里拆，避免为同一行重复解析日期。固定列表跨工作区，
   * 因此按最近活动时间统一排序；Repositories 保留原来的工作区顺序。
   */
  const pinned = useMemo(
    () =>
      painted
        .flatMap((group) => group.members)
        .filter(({ thread }) => thread.isPinned)
        .sort((left, right) => right.thread.updatedAt.localeCompare(left.thread.updatedAt)),
    [painted],
  )

  const recent = useMemo(
    () =>
      painted
        .filter((group) => projectlessWorkspaces.has(group.id))
        .flatMap((group) => group.members)
        .filter(({ thread }) => !thread.isPinned)
        .sort((left, right) => right.thread.updatedAt.localeCompare(left.thread.updatedAt)),
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
   * 每组已经展开到第几条。
   *
   * 放在这一层而不是组头里：map 里开不了 hook，而组的身份会随数据增删变化 ——
   * 状态跟着组件走就会在重挂载时丢。它只活这一次会话，所以不落盘；收起来那一份
   * 要活得更久，因此不在这里，由宿主传进来。
   */
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(NO_PAGES)

  const showMore = useCallback((workspaceId: string) => {
    setShown((held) => new Map(held).set(workspaceId, (held.get(workspaceId) ?? PAGE) + PAGE))
  }, [])

  /*
   * 首帧给出行的形状，不给结论。
   *
   * "还没有对话"是一个只有读完才成立的断言，把它当加载态显示，等于每次
   * 开窗都先告诉用户一件错误的事。骨架行是列表类界面的通行做法。
   */
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
      key={thread.id}
      onActivate={onActivate}
      onArchive={onArchive}
      onBeginRename={beginRename}
      onCancelRename={cancelRename}
      onCommitRename={commitRename}
      onFork={onFork}
      onOpenInNewTab={onOpenInNewTab}
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
            label="Pinned"
            onToggle={() => {
              setPinOpen((open) => !open)
            }}
          />

          {isPinOpen ? (
            <ul className="assistant-threads__list">{pinned.map(renderThread)}</ul>
          ) : null}
        </section>
      )}

      <section className="assistant-threads__section">
        <ThreadSectionHeader
          isOpen={isRepositoriesOpen}
          label="Repositories"
          onToggle={() => {
            setRepositoriesOpen((open) => !open)
          }}
        />

        {isRepositoriesOpen ? (
          <>
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
               * 名字缺席的那一组不长组头。
               *
               * 缺席说的是「这些对话的工作目录还没有被记下来」，不是「它们没有工作
               * 区」：会话本来就是对着一个目录开的。缺的是那个目录到这一层的路，所以
               * 这里没有任何东西可以写在组头上。替它编一个名字（此前写的是「默认工作
               * 区」）不是省事，是造一个用户问得出「它在哪」而界面答不上来的标题。
               *
               * 于是这一组按它本来的样子画：一列对话，没有标题，也没有折叠 —— 收不收
               * 起一个说不出名字的东西，不是一个能提给用户的选择。原生侧把目录记下来
               * 之后，它自然长出名字与组头，这一层不用再改。
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

                  {isOpen ? (
                    <>
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
                    </>
                  ) : null}
                </section>
              )
            })}
          </>
        ) : null}
      </section>

      {/* projectless conversations follow repositories */}
      {recent.length === 0 ? null : (
        <section className="assistant-threads__section">
          <ThreadSectionHeader
            isOpen={isRecentOpen}
            label="Recents"
            onToggle={() => {
              setRecentOpen((open) => !open)
            }}
          />

          {isRecentOpen ? (
            <ul className="assistant-threads__list">{recent.map(renderThread)}</ul>
          ) : null}
        </section>
      )}
    </nav>
  )
}
