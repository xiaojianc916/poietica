import type { FeedRow, TurnSpan } from '@poietica/agent'

/*
 * 一轮的过程折起来之后，屏幕上还剩什么。
 *
 * 折叠是屏幕的事：领域层只记下每一轮的两端（TimelineState.spans），这里决定哪几行让位
 * 给一行封条。所以它是一个纯函数 —— 没有状态、没有副作用、可以单测。
 *
 * 判据是位置，不是类型。
 *
 * 协议不说哪一句是最终回复：上游把助手的每一段文字都投成同一种帧（kimi-code 的
 * assistantDeltaToSessionUpdate 只发 sessionUpdate 与 content 两格），而真实录制里助手
 * 文字既出现在工具调用之后，也可以出现在它之前。所以「助手文字 = 最终回复」这个类型
 * 判据会把开场那句话也当成回复，折叠区从中间被劈开。判据只能是：这一轮落定之后，从
 * 末尾往回走，跳过旁注，第一条必须是助手文字 —— 它才是回复；撞上思考、计划或工具，
 * 说明这一轮以过程收尾，那就一个字都不折。
 */

/** 一条封条要显示的东西。 */
export interface TurnSealPlan {
  readonly turn: number
  readonly startedAt: number
  /** 缺席就是这一轮还在跑。 */
  readonly endedAt: number | undefined
  /** 有没有可折的过程：没有就不给它一个按下去什么都不会发生的按钮。 */
  readonly hasProcess: boolean
  readonly isOpen: boolean
}

export interface FoldedFeed {
  readonly rows: readonly FeedRow[]
  /** 键是那一行的 id：封条画在它上面。 */
  readonly seals: ReadonlyMap<string, TurnSealPlan>
}

const NO_SEALS: ReadonlyMap<string, TurnSealPlan> = new Map()

/*
 * 旁注不是话。
 *
 * 一次权限请求、一条本地事故都可能落在一轮的最后 ——「批准之后就结束了」是常态。找
 * 回复时跳过它们，否则一轮以审批记录收尾就会被判成没有回复。它们也从不被折起：一条
 * 报错藏进折叠区，等于把它删掉。
 */
const ASIDE: ReadonlySet<FeedRow['item']['type']> = new Set<FeedRow['item']['type']>([
  'error',
  'permission',
])

/*
 * 人说的话永不折起。
 *
 * agent 还在跑时插进来的那一句落在这一轮里（见 appendUserMessage 的判据），所以一轮里
 * 可以有第二句人话。它是这条对话的原始数据，屏幕上任何一个开关都没有资格让它消失。
 */
const SAID = 'user_message'

export function foldFeed(
  rows: readonly FeedRow[],
  spans: readonly TurnSpan[],
  opened: ReadonlySet<number>,
): FoldedFeed {
  /* 没有一轮记下过两端（这一格加进来之前的日志）：没有封条，也不折任何东西。 */
  if (spans.length === 0 || rows.length === 0) {
    return { rows, seals: NO_SEALS }
  }

  const byTurn = groupByTurn(rows)
  const seals = new Map<string, TurnSealPlan>()
  const hidden = new Set<FeedRow>()

  for (const span of spans) {
    const turn = byTurn.get(span.turn)

    if (turn === undefined) {
      continue
    }

    /* 还在跑的一轮一律摊开：过程正在长出来，此刻收起它就是把正在发生的事藏起来。 */
    const answer = span.endedAt === undefined ? -1 : finalReplyIn(turn)
    const process = answer === -1 ? [] : processIn(turn, answer)
    const isOpen = process.length === 0 || opened.has(span.turn)

    if (!isOpen) {
      for (const row of process) {
        hidden.add(row)
      }
    }

    /*
     * 封条画在这一轮第一行「不是人话」的那一行上面：它因此恒在问题与回复之间，收起
     * 或摊开都不动位置。挂在人话那一行下面也能得到同一个位置，但一轮不一定有人话 ——
     * 早先录下的日志没有 prompt 那一格（见 RunEvent.run_started 上的注释）。
     */
    const anchor = turn.find((row) => row.item.type !== SAID && !hidden.has(row))

    if (anchor !== undefined) {
      seals.set(anchor.item.id, {
        turn: span.turn,
        startedAt: span.startedAt,
        endedAt: span.endedAt,
        hasProcess: process.length > 0,
        isOpen,
      })
    }
  }

  /* 一行都没折时原样交回入参那个数组：下游的投影缓存按引用比较，不该被白打掉。 */
  return hidden.size === 0
    ? { rows, seals }
    : { rows: rows.filter((row) => !hidden.has(row)), seals }
}

/* 一趟分桶，而不是每一轮各扫一遍全表 —— 后者在长对话里是 O(行 × 轮)。 */
function groupByTurn(rows: readonly FeedRow[]): Map<number, FeedRow[]> {
  const byTurn = new Map<number, FeedRow[]>()

  for (const row of rows) {
    const bucket = byTurn.get(row.item.turn)

    if (bucket === undefined) {
      byTurn.set(row.item.turn, [row])
    } else {
      bucket.push(row)
    }
  }

  return byTurn
}

/** 这一轮的最终回复在第几行，没有就是 -1。 */
function finalReplyIn(turn: readonly FeedRow[]): number {
  for (let at = turn.length - 1; at >= 0; at -= 1) {
    const row = turn[at]

    if (row === undefined || ASIDE.has(row.item.type)) {
      continue
    }

    return row.item.type === 'agent_text' ? at : -1
  }

  return -1
}

/** 回复之前那些可以折起来的行：思考、计划、工具，以及中途说的那几句话。 */
function processIn(turn: readonly FeedRow[], answer: number): readonly FeedRow[] {
  const process: FeedRow[] = []

  for (let at = 0; at < answer; at += 1) {
    const row = turn[at]

    if (row === undefined || row.item.type === SAID || ASIDE.has(row.item.type)) {
      continue
    }

    process.push(row)
  }

  return process
}
