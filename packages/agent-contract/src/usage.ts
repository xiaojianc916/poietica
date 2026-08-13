/*
 * 一条会话的上下文用量。
 *
 * 数由 agent 算，不由本应用算。ACP 只有一条路说这件事：session/update 里的
 * usage_update，载荷恒为最新值，到达即替换。Kimi 在每轮答复落定之后补报一次
 * （上游 acp-server 的 session.ts：settleDriver 先 resolve 再 emitUsageUpdate）。
 *
 * 线上形状由原生侧的生成绑定说了算，这里只声明端口要的那个名字。
 */

/** 一份用量：上下文窗口用掉多少、一共多大。 */
export interface SessionUsage {
  /** 已占用的 token 数。 */
  readonly used: number
  /** 上下文窗口总量，token 数。 */
  readonly size: number
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
