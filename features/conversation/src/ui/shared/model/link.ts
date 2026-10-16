/** 一帧的载荷（RunFrame::LinkChanged），重放对话会原样再演一遍；字段名与原生 LinkState 逐字相同，别改。 */
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
