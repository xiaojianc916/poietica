import type { FeedRow, ToolCallTimelineItem } from '@poietica/agent'

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
 * 白名单认的是产品的 kind（由 kap 的 display 在 kap-projection.ts 一次判完），不是
 * 工具名 —— 工具名随上游版本改。表外的 kind 不并：把语义未知的几条并成「其他 3 项」
 * 是纯粹的信息损失，读者反而要多点一次。
 */

export type ToolGroupKind = 'read' | 'search' | 'fetch' | 'execute' | 'write'

/** 白名单。表外的 kind 不参与聚合。 */
const GROUPED = new Map<ToolCallTimelineItem['kind'], ToolGroupKind>([
  ['read', 'read'],
  ['search', 'search'],
  ['fetch', 'fetch'],
  ['execute', 'execute'],
  /* 两档并作一类：新写与改写，读者眼里都是「动了文件」。 */
  ['write', 'write'],
  ['edit', 'write'],
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

  return GROUPED.get(row.item.kind)
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

/**
 * 组里此刻正在跑的那一条。全都落定就返回 undefined。
 *
 * 倒着找第一条还在飞的：members 是屏幕顺序，也就是到达顺序，所以倒序里第一条命中的就是
 * 最晚开始的那一条。串行派发时它就是「唯一那条」；并行派发时取最晚的那条，因为这一格
 * 说的是「现在」，而最晚开始的最接近现在。
 *
 * 判据只借 FeedRow.isInFlight，不看 startedAt：那一格是不是时间戳、是什么单位，都是条目
 * 那一层的约定；而到达顺序是这个数组自己的事实，不会随协议改口。
 */
export function liveMemberOf(plan: ToolGroupPlan): FeedRow | undefined {
  for (let at = plan.members.length - 1; at >= 0; at -= 1) {
    const row = plan.members[at]

    if (row?.isInFlight) {
      return row
    }
  }

  return undefined
}
