import type { FeedRow, ToolCallTimelineItem } from '@poietica/agent'
import { readToolKind } from '../semantics/tool-kind'

/*
 * 连续的同类工具调用合成一组。
 *
 * 这是一次派生，不是一个状态：输入是屏幕上真正要滚的那个数组，输出是合并之后的行，
 * 以及每一组挂在哪一行上。它不持有任何领域事实，所以「这几条并没并」不可能与屏幕上
 * 显示的东西对不上。
 *
 * 为什么不进 turn-fold：那一层折的是「一整轮的过程」，判据是轮次与封条；这一层并的是
 * 「相邻的同类调用」，判据只有 kind 与相邻。两件事各自成立，混在一处会让 TurnFold 的
 * 复用判据同时看两组不相干的事实。
 *
 * 为什么不改 FeedRow：行与条目在 feed-rows.ts 里是严格一对一的（rowOf 是条目下标到行
 * 下标的映射，ROWS 把行的身份挂在单个条目上）。让一行承载 N 条会打穿那一整套增量复用，
 * 而 turn-identity.test.ts 正守着它。所以组不是一种行 —— 它像封条一样挂在行外面，key 是
 * 组内第一条的 id。第一条那一行原样留在数组里，其余的被摘掉。
 *
 * 于是「第二条到达就无缝并成组」是免费的：首行的身份从头到尾没有换过，虚拟器的
 * getItemKey 与瞬态区 AnimatePresence 的 key 都不动，不闪。
 *
 * 白名单认的是 ACP 的 kind，不是工具名。工具名是某一家 agent 的私有词汇（见
 * semantics/tool-intent.ts 顶上那段：接第二家 agent 时那些键要搬进 AgentDialect），
 * 而 kind 是协议的（agent-contract/protocol.ts 从上游 SDK 直接 re-export）。认工具名的
 * 白名单会在接第二家 agent 那天静默失效。
 *
 * 查表之前先过一道 readToolKind（semantics/tool-kind.ts）：上游漏填 kind 的调用在那里
 * 按入参形状认一次，认得出来的照常并组，认不出来的仍然是 other。查的仍然是 kind。
 *
 * 表里没有的 kind 一律不并：other 是协议的默认档，MCP 与 skill 都落在那里 —— 把语义
 * 未知的几条并成「其他 3 项」是纯粹的信息损失，读者反而要多点一次。think 不上屏
 * （renderable.ts）。协议将来长出新档时也落在这里，退化成单卡，而不是落进一个不存在的
 * 分支。
 */

export type ToolGroupKind = 'read' | 'search' | 'fetch' | 'execute' | 'write'

/** 白名单。表外的 kind 不参与聚合。 */
const GROUPED = new Map<ToolCallTimelineItem['kind'], ToolGroupKind>([
  ['read', 'read'],
  ['search', 'search'],
  ['fetch', 'fetch'],
  ['execute', 'execute'],
  /* 三档并作一类：改内容、删掉、改名，读者眼里都是「动了文件」。 */
  ['edit', 'write'],
  ['delete', 'write'],
  ['move', 'write'],
])

/** 少于这个数不成组：一条调用就是一条普通行，不套组壳。 */
const LEAST = 2

export interface ToolGroupPlan {
  readonly kind: ToolGroupKind
  /** 按屏幕顺序，第一条就是挂着这一组的那一行。 */
  readonly members: readonly FeedRow[]
}

export interface ToolGrouping {
  readonly rows: readonly FeedRow[]
  /** key 是组内第一条的 id —— 那一行仍在 rows 里，其余的已被摘掉。 */
  readonly groups: ReadonlyMap<string, ToolGroupPlan>
}

const NO_GROUPS: ReadonlyMap<string, ToolGroupPlan> = new Map()

interface GroupProjection {
  readonly rows: readonly FeedRow[]
  readonly result: ToolGrouping
}

/* 投影按 rows[0] 弱引用：键天然按对话隔离，也随对话一起回收。与 turn-fold 的 FOLDS 同一套。 */
const GROUPINGS = new WeakMap<FeedRow, GroupProjection>()

/** 这一行参不参与聚合，参与的话算哪一类。 */
function kindOf(row: FeedRow | undefined): ToolGroupKind | undefined {
  if (row === undefined || row.item.type !== 'tool_call') {
    return undefined
  }

  return GROUPED.get(readToolKind(row.item))
}

/**
 * 从 at 起，连续同类同轮的一段到哪里为止。
 *
 * 不跨轮：轮号是条目自己的事实（TimelineEntry.turn），跨轮并组会把两次提问的动作
 * 混成一堆。中间任何一条不同类的行（旁白、回复、别的 kind）都会让这一段就此打住。
 */
function runEndsAt(
  rows: readonly FeedRow[],
  at: number,
  kind: ToolGroupKind,
  turn: number,
): number {
  let end = at + 1

  while (end < rows.length) {
    const next = rows[end]

    if (next === undefined || kindOf(next) !== kind || next.item.turn !== turn) {
      break
    }

    end += 1
  }

  return end
}

export function groupTools(rows: readonly FeedRow[]): ToolGrouping {
  const anchor = rows[0]

  if (anchor === undefined) {
    return { rows, groups: NO_GROUPS }
  }

  const held = GROUPINGS.get(anchor)

  if (held !== undefined && held.rows === rows) {
    return held.result
  }

  const groups = new Map<string, ToolGroupPlan>()
  const kept: FeedRow[] = []
  let at = 0

  while (at < rows.length) {
    const row = rows[at]

    if (row === undefined) {
      at += 1
      continue
    }

    const kind = kindOf(row)

    if (kind === undefined) {
      kept.push(row)
      at += 1
      continue
    }

    const end = runEndsAt(rows, at, kind, row.item.turn)

    kept.push(row)

    if (end - at < LEAST) {
      at += 1
      continue
    }

    groups.set(row.item.id, { kind, members: rows.slice(at, end) })
    at = end
  }

  /* 一组都没并就把入参原样交回：引用稳定是下游投影缓存的前提，与 foldRows 同一条规矩。 */
  const result: ToolGrouping =
    groups.size === 0 ? { rows, groups: NO_GROUPS } : { rows: kept, groups }

  GROUPINGS.set(anchor, { rows, result })

  return result
}
