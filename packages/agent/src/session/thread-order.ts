import type { ThreadRecord } from '@poietica/agent-contract'
import { normalizeWorkspaceRoot, workspaceRootName } from '@poietica/core'

/*
 * 会话列表的次序与分组，一份规则。
 *
 * 一级索引是**工作区**，不是时间。时间桶（今天／昨天／过去 7 天）曾经长在视图
 * 组件里（agent-ui 的 threads/relative-time.ts），那是个人聊天机器人的信息架构：它
 * 假设「什么时候说的」是找回一条对话的主线索。对着一个工作目录干活的 agent
 * 客户端不是那样 —— 主线索是「在哪个项目里」，时间退回行尾那一格的元数据。
 *
 * 「已固定」那个独立段也一并没了：它与工作区正交，会把某个工作区的固定项抽到
 * 别的工作区之上。固定优先本来就写在 byRecency 里，一处足够，两处必然分叉。
 */

/** 一条对话，列表需要它的样子。 */
export interface ThreadListItem {
  readonly id: string
  readonly title: string
  readonly isPinned: boolean
  readonly updatedAt: string
  /** 它属于哪个工作区。见 workspaceIdOf。 */
  readonly workspaceId: string
}

export interface ThreadsList {
  readonly items: readonly ThreadListItem[]
  readonly isLoading: boolean
  readonly failure: string | null
}

/** 一个工作区，以及它下面的对话。 */
export interface ThreadWorkspaceGroup {
  readonly id: string
  /**
   * 这个工作区叫什么，null 表示它的目录还没有被记下来。
   *
   * 没有名字不等于没有工作区：会话本来就是对着一个目录开的
   * （agent-runtime 的 AgentSpawn.cwd 是必填的 PathBuf）。缺的是这个目录到
   * 这一层的那条路，所以这一格如实说「不知道」，由视图决定不知道时画什么，
   * 而不是在这里编一个名字塞进去。
   */
  readonly name: string | null
  readonly items: readonly ThreadListItem[]
}

/** 分好组的列表。侧栏读的就是这个。 */
export interface ThreadWorkspaceList {
  readonly groups: readonly ThreadWorkspaceGroup[]
  readonly isLoading: boolean
  readonly failure: string | null
}

/*
 * 还没有被记下工作目录的那些对话归这一个。
 *
 * 缺席不是「不知道」，缺席就是「默认那一个」：早于这一列的那些行没有它，而那时候
 * 运行期只有一个工作目录，它们本来就都在它里面。所以那一列可空，不需要回填，也不
 * 需要兼容层。
 *
 * 新建的对话从此带着它开的那个目录（原生侧 agent_open_thread 建行时记下），
 * 分组因此按目录名裂开。
 */
export const DEFAULT_WORKSPACE_ID = 'default'

/*
 * 这条对话属于哪个工作区。
 *
 * 缺席就是默认那一个 —— 而「默认那一个」从此由宿主回答：桌面宿主说它
 * 是用户主目录（组合根用官方的 path.homeDir() 求出，见 apps/desktop 的
 * state/workspace-root.ts），于是那些没有目录的存量落在主目录那一组，
 * 有名、有组头、可折叠。只有给不出这个答案的宿主（单元测试、纯浏览器）
 * 才落回无名哨兵，那一组照旧不画组头 —— 见 workspaceNameOf。
 */
export function workspaceIdOf(thread: ThreadRecord, fallbackId?: string): string {
  const root = thread.workspaceRoot

  if (root !== null && root !== undefined && root.length > 0) {
    return normalizeWorkspaceRoot(root)
  }

  return fallbackId ?? DEFAULT_WORKSPACE_ID
}

/*
 * 一个工作区叫什么：路径的最后一段；路径不知道时没有名字。
 *
 * 默认那一个交回 null，而不是一句文案。此前这里写的是「默认工作区」——
 * 那是拿文案去填数据的缺口：屏幕上于是多出一个标题，而用户问「这个工作区在
 * 哪里」时界面答不上来。默认那一组的目录这一层确实不知道 —— 它是迁移之前的
 * 存量，行上就没有这一格；诚实的说法就是没有名字，视图据此不画组头。
 *
 * 侧栏那一列窄得放不下一条绝对路径，而人认的是项目名。两种分隔符都切，因为
 * 这个字符串来自原生侧，Windows 上是反斜杠。
 */
export function workspaceNameOf(id: string): string | null {
  if (id === DEFAULT_WORKSPACE_ID) {
    return null
  }

  return workspaceRootName(id)
}

/**
 * 组内次序：固定的在前，其余按最近活动倒序。
 *
 * 与库那条 ORDER BY 同一条规则（crates/persistence/src/threads.rs 的
 * list_threads：ORDER BY pinned DESC, updated_at DESC）。
 */
// ISO-8601 定长串按字典序即时间序，与库那条 ORDER BY 的 BINARY 排序同一规则；
// localeCompare 走的是 ICU 区域排序，会与库分叉。
function byIsoDescending(left: string, right: string): number {
  return left > right ? -1 : left < right ? 1 : 0
}

/*
 * 固定优先加最近活动倒序，规则只有这一份。库的记录（pinned?: boolean）与列表项
 * （isPinned）形状不同，各用一行薄壳接上来 —— 完整规则抄成两份必然分叉。
 */
function byPinnedThenActivity(
  leftPinned: boolean,
  leftAt: string,
  rightPinned: boolean,
  rightAt: string,
): number {
  const pinned = Number(rightPinned) - Number(leftPinned)

  return pinned === 0 ? byIsoDescending(leftAt, rightAt) : pinned
}

export function byRecency(left: ThreadRecord, right: ThreadRecord): number {
  return byPinnedThenActivity(
    left.pinned === true,
    left.updatedAt,
    right.pinned === true,
    right.updatedAt,
  )
}

/** 组内次序，作用在列表项上。 */
function byRecencyOfItem(left: ThreadListItem, right: ThreadListItem): number {
  return byPinnedThenActivity(left.isPinned, left.updatedAt, right.isPinned, right.updatedAt)
}

/**
 * 按工作区分组。
 *
 * 组的次序 = 组内最近一次活动，倒序；组内 = byRecency（固定优先）。两者用的是
 * 两道不同的尺子，这是故意的：一条被固定的老对话不该把它整个工作区顶到最上面。
 *
 * 实现上只走一趟：先按纯活动时间倒序，于是每个组第一次出现的先后本身就是组序，
 * 不需要第二次排序去求「组内最大 updatedAt」。
 */
export function groupByWorkspace(
  items: readonly ThreadListItem[],
): readonly ThreadWorkspaceGroup[] {
  const held = new Map<string, ThreadListItem[]>()

  for (const item of [...items].sort((left, right) =>
    byIsoDescending(left.updatedAt, right.updatedAt),
  )) {
    const members = held.get(item.workspaceId)

    if (members === undefined) {
      held.set(item.workspaceId, [item])
    } else {
      members.push(item)
    }
  }

  return [...held].map(([id, members]) => ({
    id,
    name: workspaceNameOf(id),
    items: members.sort(byRecencyOfItem),
  }))
}
