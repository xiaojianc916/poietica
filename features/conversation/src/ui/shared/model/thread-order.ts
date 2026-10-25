import type { ThreadRecord } from './thread'
import { normalizeWorkspaceRoot, workspaceRootName } from './workspace-root'

/*
 * 一级索引是工作区，不是时间：时间桶那道信息架构属于个人聊天机器人，而 agent 客户端的主线索是「在哪个项目里」，时间退回行尾那一格的元数据。
 */

export interface ThreadListItem {
  readonly id: string
  readonly title: string
  readonly isPinned: boolean
  readonly updatedAt: string
  /** 它属于哪个工作区。见 workspaceIdOf。 */
  readonly workspaceId: string
}

/** 一个工作区，以及它下面的对话。 */
export interface ThreadWorkspaceGroup {
  readonly id: string
  /** 叫什么；null 表示目录还没被记下来 —— 这里如实说「不知道」，不编名字塞进来。 */
  readonly name: string | null
  readonly items: readonly ThreadListItem[]
}

/* 缺席就是「默认那一个」：那一列可空、不回填，读的地方自己兜默认。 */
export const DEFAULT_WORKSPACE_ID = 'default'

/*
 * 缺席交由宿主回答「默认那一个」（桌面宿主答用户主目录），没有目录的那些对话落进有名、有组头、可折叠的那组；
 * 给不出答案的宿主（单元测试、纯浏览器）才落回无名哨兵，那一组不画组头。
 */
export function workspaceIdOf(thread: ThreadRecord, fallbackId?: string): string {
  const root = thread.workspaceRoot

  if (root !== null && root !== undefined && root.length > 0) {
    return normalizeWorkspaceRoot(root)
  }

  return fallbackId ?? DEFAULT_WORKSPACE_ID
}

/*
 * 路径最后一段；路径不知道时没有名字。默认那一个交回 null 而非文案 —— 拿文案填数据的缺口会多出一个标题，用户问「这个工作区在哪」时界面答不上来。
 * 两种分隔符都切，这个字符串来自原生侧，Windows 上是反斜杠。
 */
export function workspaceNameOf(id: string): string | null {
  if (id === DEFAULT_WORKSPACE_ID) {
    return null
  }

  return workspaceRootName(id)
}

/**
 * 固定的在前，其余按最近活动倒序。与库那条 ORDER BY 同一条规则（crates/ledger/src/index/threads.rs 的 list_threads）。
 */
// ISO-8601 定长串按字典序即时间序（与库的 BINARY 排序同一规则）；localeCompare 走 ICU 区域排序，会与库分叉。
export function byIsoDescending(left: string, right: string): number {
  return left > right ? -1 : left < right ? 1 : 0
}

/* 固定优先加最近活动倒序，规则只有这一份。库记录与列表项形状不同，各一行薄壳接上。 */
function byPinnedThenActivity(leftPinned: boolean, leftAt: string, rightPinned: boolean, rightAt: string): number {
  const pinned = Number(rightPinned) - Number(leftPinned)

  return pinned === 0 ? byIsoDescending(leftAt, rightAt) : pinned
}

export function byRecency(left: ThreadRecord, right: ThreadRecord): number {
  return byPinnedThenActivity(left.pinned === true, left.updatedAt, right.pinned === true, right.updatedAt)
}

/** 组内次序，作用在列表项上。 */
function byRecencyOfItem(left: ThreadListItem, right: ThreadListItem): number {
  return byPinnedThenActivity(left.isPinned, left.updatedAt, right.isPinned, right.updatedAt)
}

/**
 * 组序 = 组内最近活动倒序，组内 = byRecency（固定优先）—— 两把尺子是故意的：被固定的老对话不该把它整个工作区顶到最上面。
 * 只走一趟：先按纯活动倒序，每个组首次出现的先后本身就是组序。
 * `nameOf` 是组名的解析口：线程带的是**工作区实体 id**（不是根路径），所以组名要交给持有工作区表的那一层；缺席时退回「按路径取末段」。
 */
export function groupByWorkspace(
  items: readonly ThreadListItem[],
  nameOf: (workspaceId: string) => string | null = workspaceNameOf,
): readonly ThreadWorkspaceGroup[] {
  const held = new Map<string, ThreadListItem[]>()

  for (const item of [...items].sort((left, right) => byIsoDescending(left.updatedAt, right.updatedAt))) {
    const members = held.get(item.workspaceId)

    if (members === undefined) {
      held.set(item.workspaceId, [item])
    } else {
      members.push(item)
    }
  }

  return [...held].map(([id, members]) => ({
    id,
    name: nameOf(id),
    items: members.sort(byRecencyOfItem),
  }))
}
