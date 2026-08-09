import type { FeedRow, TurnSpan } from '@poietica/agent'

/*
 * 折叠是一次派生，不是一个状态。
 *
 * 输入是屏幕上真正在滚的那个数组、每一轮的起止、人手动点开过哪几轮；输出是交给
 * 列表的行，加上每一轮的封条挂在哪一行。这里不持有任何东西，所以「这一轮折没折」
 * 不可能与屏幕上显示的东西对不上。
 *
 * 什么算最终回复，判据只有一条：这一轮末尾（跳过报错与授权这类旁白）那一条是
 * agent_text。不按类型认 —— 协议给不出「这条是最终回复」的标记，上游的
 * agent_message_chunk 只有 sessionUpdate 与 content 两格（kimi-code 的
 * events-map.ts），一句开场白与一句结论在报文里逐字同形。位置能分开它们：结论
 * 后面不会再有过程，开场白后面还有。所以模型先说一句再去调工具时，末尾不再是
 * agent_text，这一轮当场自动摊开继续滚 —— 折叠区永远精确等于「最后那段回复之前
 * 的全部过程」，不需要闩锁，也不会藏掉任何一条。
 */

export type TurnSealPlan = {
  readonly turn: number
  readonly startedAt: number
  readonly endedAt: number | undefined
  readonly hasProcess: boolean
  readonly isOpen: boolean
}

export type FoldedFeed = {
  readonly rows: readonly FeedRow[]
  readonly seals: ReadonlyMap<string, TurnSealPlan>
}

export const NO_SEALS: ReadonlyMap<string, TurnSealPlan> = new Map()

/** 旁白：不是过程也不是回复。倒扫时跨过它，也永远不折。 */
const ASIDE: ReadonlySet<FeedRow['item']['type']> = new Set(['error', 'permission'])

const SAID: FeedRow['item']['type'] = 'user_message'

export function foldFeed(
  rows: readonly FeedRow[],
  spans: readonly TurnSpan[],
  opened: ReadonlySet<number>,
): FoldedFeed {
  if (spans.length === 0) {
    return { rows, seals: NO_SEALS }
  }

  const byTurn = groupByTurn(rows)
  const seals = new Map<string, TurnSealPlan>()
  const folded = new Set<number>()

  for (const span of spans) {
    const own = byTurn.get(span.turn)

    if (own === undefined) {
      continue
    }

    const answerAt = finalReplyIn(rows, own)
    const process = answerAt < 0 ? [] : processIn(rows, own, answerAt)
    /* 可点 ⟺ 真有东西可收。还没有回复时封条只是一行字，不给假按钮。 */
    const hasProcess = process.length > 0
    const isOpen = !hasProcess || opened.has(span.turn)
    const hidden = isOpen ? undefined : new Set(process)

    if (hidden !== undefined) {
      for (const at of hidden) {
        folded.add(at)
      }
    }

    /* 封条挂在这一轮第一条「不是人话、且没被折掉」的行上面：收起时那是回复的首
       行，摊开时那是第一条过程 —— 两种状态下它都恰在提问与内容之间，不会挪。 */
    const anchor = own.find((at) => rows[at]?.item.type !== SAID && hidden?.has(at) !== true)
    const id = anchor === undefined ? undefined : rows[anchor]?.item.id

    if (id !== undefined) {
      seals.set(id, {
        turn: span.turn,
        startedAt: span.startedAt,
        /* 秒表停在回复的第一帧，不是这一轮的末尾：之后流出来的是答案，不是处理。
           一个字都没说就收场的轮次（取消、报错）退回这一轮真正的结束时间，于是
           它照样显示「已处理 Xm Ys」而不是永远跳字。 */
        endedAt: (answerAt < 0 ? undefined : rows[answerAt]?.item.at) ?? span.endedAt,
        hasProcess,
        isOpen,
      })
    }
  }

  if (folded.size === 0) {
    /* 一行都没折就把入参原样交回：引用稳定是下游记忆化的前提。 */
    return { rows, seals: seals.size === 0 ? NO_SEALS : seals }
  }

  return { rows: rows.filter((_, at) => !folded.has(at)), seals }
}

/** 一趟分桶。按轮次逐轮筛一遍是 O(行×轮)，这条对话越长越贵。 */
function groupByTurn(rows: readonly FeedRow[]): Map<number, number[]> {
  const byTurn = new Map<number, number[]>()

  for (const [at, one] of rows.entries()) {
    const own = byTurn.get(one.item.turn)

    if (own === undefined) {
      byTurn.set(one.item.turn, [at])
    } else {
      own.push(at)
    }
  }

  return byTurn
}

function finalReplyIn(rows: readonly FeedRow[], own: readonly number[]): number {
  for (let index = own.length - 1; index >= 0; index -= 1) {
    const at = own[index]

    if (at === undefined) {
      continue
    }

    const type = rows[at]?.item.type

    if (type === undefined || ASIDE.has(type)) {
      continue
    }

    return type === 'agent_text' ? at : -1
  }

  return -1
}

function processIn(
  rows: readonly FeedRow[],
  own: readonly number[],
  answerAt: number,
): readonly number[] {
  return own.filter((at) => {
    const type = rows[at]?.item.type

    return at < answerAt && type !== undefined && type !== SAID && !ASIDE.has(type)
  })
}
