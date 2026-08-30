/**
 * 这条连接此刻的链路态。
 *
 * 它是一帧的载荷（frame.rs 的 RunFrame::LinkChanged），所以重放一条对话会原样
 * 再演一遍。判别式与字段名与原生侧的 LinkState 逐字相同
 * （crates/kap-client/src/link.rs）。
 */
export type SessionLink =
  | {
      readonly state: 'retrying'
      readonly attempt: number
      readonly of: number
      /** 下一次重连的时刻（epoch 毫秒）；等于此刻表示正在拨号。 */
      readonly retryAt: number
      readonly reason: string
    }
  | { readonly state: 'recovered'; readonly reason: string }
  | { readonly state: 'severed'; readonly attempts: number; readonly reason: string }
