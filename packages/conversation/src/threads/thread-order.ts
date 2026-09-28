import type { ThreadRecord } from '../agent/thread'
import { normalizeWorkspaceRoot, workspaceRootName } from './workspace-root'

/*
 * 会话列表的次序与分组，一份规则。一级索引是工作区，不是时间：时间桶曾长在视图组件里
 * （surface/threads/relative-time.ts），那是个人聊天机器人的信息架构 —— agent 客户端的
 * 主线索是「在哪个项目里」，时间退回行尾那一格的元数据。「已固定」独立段也一并没了：
 * 它与工作区正交，且固定优先已写在 byRecency 里，两处必然分叉。
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
  /** 叫什么；null 表示目录还没被记下来。缺的不是工作区（会话本就对着目录开），这里如实说「不知道」，不编名字塞进来。 */
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
 * 没记下工作目录的对话归这一个。缺席就是「默认那一个」：早于这一列的行只有当时唯一的
 * 工作目录，本来就都在它里面 —— 那一列可空、不回填、不需要兼容层。新对话由原生侧
 * agent_open_thread 建行时记下目录，分组因此按目录名裂开。
 */
export const DEFAULT_WORKSPACE_ID = 'default'

/*
 * 这条对话属于哪个工作区。缺席交由宿主回答「默认那一个」：桌面宿主答用户主目录
 * （组合根用官方 path.homeDir() 求出，见 apps/desktop 的 state/workspace-root.ts），
 * 没有目录的存量落进有名、有组头、可折叠的那组；给不出答案的宿主（单元测试、纯
 * 浏览器）才落回无名哨兵，那一组不画组头 —— 见 workspaceNameOf。
 */
export function workspaceIdOf(thread: ThreadRecord, fallbackId?: string): string {
  const root = thread.workspaceRoot

  if (root !== null && root !== undefined && root.length > 0) {
    return normalizeWorkspaceRoot(root)
  }

  return fallbackId ?? DEFAULT_WORKSPACE_ID
}

/*
 * 工作区叫什么：路径最后一段；路径不知道时没有名字。默认那一个交回 null 而非文案 ——
 * 此前写「默认工作区」是拿文案填数据的缺口：多出一个标题，用户问「这个工作区在哪」
 * 时界面答不上来。侧栏窄得放不下绝对路径，人认的是项目名；两种分隔符都切，这个字符
 * 串来自原生侧，Windows 上是反斜杠。
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
 * 与库那条 ORDER BY 同一条规则（crates/ledger/src/index/threads.rs 的
 * list_threads：ORDER BY pinned DESC, updated_at DESC）。
 */
// ISO-8601 定长串按字典序即时间序（与库 ORDER BY 的 BINARY 排序同一规则）；localeCompare 走 ICU 区域排序，会与库分叉。
export function byIsoDescending(left: string, right: string): number {
  return left > right ? -1 : left < right ? 1 : 0
}

/* 固定优先加最近活动倒序，规则只有这一份。库记录（pinned?: boolean）与列表项（isPinned）形状不同，各一行薄壳接上。 */
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
 * 按工作区分组。组序 = 组内最近活动倒序，组内 = byRecency（固定优先）—— 两把尺子是
 * 故意的：被固定的老对话不该把它整个工作区顶到最上面。实现只走一趟：先按纯活动倒序，
 * 每个组首次出现的先后本身就是组序，不需要第二次排序求「组内最大 updatedAt」。
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
