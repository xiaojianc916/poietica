/*
 * 一条会话的上下文用量。
 *
 * 数由 agent 算，不由本应用算。ACP 只有一条路说这件事：session/update 里的
 * usage_update，载荷恒为最新值，到达即替换。Kimi 在每轮答复落定之后补报一次
 * （上游 acp-server 的 session.ts：settleDriver 先 resolve 再 emitUsageUpdate），
 * cost 一格它从不带 —— 引擎没有价格表。所以 cost 缺席是常态，界面不许编造。
 */

/** agent 报出的花费，带币种。Kimi 不报它。 */
export interface SessionUsageCost {
  readonly amount: number
  readonly currency: string
}

/** 一份用量：上下文窗口用掉多少、一共多大。 */
export interface SessionUsage {
  /** 已占用的 token 数。 */
  readonly used: number
  /** 上下文窗口总量，token 数。 */
  readonly size: number
  /** agent 报了花费才有这一格。 */
  readonly cost?: SessionUsageCost
}

/** 一条会话报来的一份用量。 */
export interface SessionUsageReport {
  readonly sessionId: string
  readonly usage: SessionUsage
}

/**
 * 用量这一路。只有听：它是 agent 主动推的，没有任何命令能把它问回来。
 */
export interface SessionUsagePort {
  /** 听 agent 报用量。返回退订。 */
  readonly subscribe: (handler: (report: SessionUsageReport) => void) => () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/*
 * 一份线上载荷里的用量，如果它确实读得成用量。
 *
 * 交回 undefined 表示"这一条不是用量"，不该覆盖已经收到的那一份 —— 与
 * paletteFrom 同一条规矩。cost 读不成时只丢 cost：used/size 仍是真话。
 */
export function sessionUsageOf(value: unknown): SessionUsage | undefined {
  if (!isRecord(value) || typeof value['used'] !== 'number' || typeof value['size'] !== 'number') {
    return undefined
  }

  const cost = value['cost']

  if (
    isRecord(cost) &&
    typeof cost['amount'] === 'number' &&
    typeof cost['currency'] === 'string'
  ) {
    return {
      used: value['used'],
      size: value['size'],
      cost: { amount: cost['amount'], currency: cost['currency'] },
    }
  }

  return { used: value['used'], size: value['size'] }
}
