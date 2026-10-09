import type { Interaction, SubmitInput, UsageSample } from '@poietica/engine'

/** 一轮里依次发生的事情。FakeEngine 与 omp mock 都由它驱动（12 页 §0.1） */
export type ScenarioStep =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | { readonly kind: 'tool'; readonly name: string; readonly args: unknown; readonly result: string }
  | {
      readonly kind: 'interaction'
      readonly interaction: DistributiveOmit<Interaction, 'id' | 'createdAt' | 'timeoutAt'>
    } // 等待 respond 后继续
  | { readonly kind: 'usage'; readonly usage: Omit<UsageSample, 'at'> }
  | { readonly kind: 'fail'; readonly code: string; readonly message: string }

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** 一轮的步骤序列 */
export type ScenarioTurn = readonly ScenarioStep[]

export type ScenarioScript = (input: SubmitInput, turnIndex: number) => ScenarioTurn

/** 不传 script 时的默认回复：一段文本 "ok" */
export const defaultScript: ScenarioScript = () => [{ kind: 'text', text: 'ok' }]

/** 常用构造：只回一段文本 */
export const say = (text: string): ScenarioStep => ({ kind: 'text', text })

/** 常用构造：调用一个工具 */
export const callTool = (name: string, args: unknown, result = ''): ScenarioStep => ({
  kind: 'tool',
  name,
  args,
  result,
})
