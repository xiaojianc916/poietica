/*
 * 一条会话的上下文用量与累计输入构成。
 *
 * 数由 agent 算，不由本应用算。kap 的 agent.status.updated 一帧带全两样：
 * 此刻的上下文占用（used / size）与会话累计的输入三格（usage.total，协议形状
 * 见 contracts/kap 钉住的 events-zod 快照）。推送是 volatile 的：载荷恒为
 * 最新值，到达即替换，断线不回放。
 *
 * 线上形状由原生侧的生成绑定说了算，这里只声明端口要的那个名字。
 */

/** 一份用量：上下文占用，以及会话累计输入的构成（三格合计即总输入）。 */
export interface SessionUsage {
  /** 已占用的 token 数。 */
  readonly used: number
  /** 上下文窗口总量，token 数。 */
  readonly size: number
  /** 累计输入里未命中缓存的部分。 */
  readonly inputOther: number
  /** 累计输入里命中缓存的部分。 */
  readonly inputCacheRead: number
  /** 累计输入里写入缓存的部分。 */
  readonly inputCacheCreation: number
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
