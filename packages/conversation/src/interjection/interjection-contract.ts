import type { PromptAsset, PromptConfiguration, PromptSkill } from '@poietica/agent-contract'

/** 一条还没上路的插话。 */
export interface Interjection {
  readonly id: string
  readonly text: string
  readonly assets: readonly PromptAsset[]
  readonly configuration: readonly PromptConfiguration[]
  readonly skills: readonly PromptSkill[]
  /** editing 表示正文此刻在输入框里，位置留着。 */
  readonly state: 'queued' | 'editing'
}

/** 人说的那一句，还没有身份。 */
export type Said = Omit<Interjection, 'id' | 'state'>

export interface OutboxState {
  readonly queue: readonly Interjection[]
  /** 已交出去、还没落定的那一条。恒为零或一 —— 一次只放一条。 */
  readonly inflight: Interjection | undefined
  readonly editing: string | undefined
}

/** 出账簿要用的外界能力，全部注入。 */
export interface OutboxPort {
  /** 把这一条交给会话；转录记账在那一侧。 */
  readonly deliver: (said: Interjection) => void
  /** 把 kap 已收下的那一条并进正在跑的这一轮。 */
  readonly merge: (promptId: string) => void
  readonly isBusy: () => boolean
}
