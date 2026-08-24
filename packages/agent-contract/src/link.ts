/**
 * 这条连接此刻的链路态。
 *
 * 链路态不是回合的一部分：它不占帧的序号、不进帧日志，所以重放一条对话不会
 * 再演一遍。判别式与字段名与原生侧的 LinkState 逐字相同
 * （crates/agent-runtime/src/link.rs）。
 */
export type SessionLink =
  | { readonly state: 'linked' }
  | {
      readonly state: 'waiting'
      /** 最后一帧到达的时刻（epoch 毫秒）。 */
      readonly since: number
    }
  | {
      readonly state: 'retrying'
      readonly attempt: number
      readonly of: number
      /** 下一次重连的时刻（epoch 毫秒）；倒计时由读的人自己算。 */
      readonly retryAt: number
      readonly reason: string
    }

/** 链路态的到达口。只有订阅：没有哪个命令能把它问回来。 */
export interface SessionLinkPort {
  readonly subscribe: (handler: (link: SessionLink) => void) => () => void
}
