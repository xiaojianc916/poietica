import type { Interaction, SubmitInput, UsageSample } from '@poietica/engine'

/** 一轮里依次发生的事情。FakeEngine 与 omp mock 都由它驱动。 */
export type ScenarioStep =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | { readonly kind: 'tool'; readonly name: string; readonly args: unknown; readonly result: string }
  | {
      readonly kind: 'interaction'
      readonly interaction: DistributiveOmit<Interaction, 'id' | 'createdAt' | 'timeoutAt'>
    } // 等待 respond 后继续
  | { readonly kind: 'usage'; readonly usage: Omit<UsageSample, 'at'> }
  /* 工具写了一个文件：真引擎在写的那一刻报前后正文，替身在这里报同样的一份 */
  | { readonly kind: 'file'; readonly path: string; readonly before: string | null; readonly after: string }
  | { readonly kind: 'fail'; readonly code: string; readonly message: string }

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type ScenarioTurn = readonly ScenarioStep[]

export type ScenarioScript = (input: SubmitInput, turnIndex: number) => ScenarioTurn

export const defaultScript: ScenarioScript = () => [{ kind: 'text', text: 'ok' }]

export const say = (text: string): ScenarioStep => ({ kind: 'text', text })

export const callTool = (name: string, args: unknown, result = ''): ScenarioStep => ({
  kind: 'tool',
  name,
  args,
  result,
})

/** 工具写了一个文件（撤销那条路的事实源）：before 为 null = 写之前它不存在 */
export const writeFile = (path: string, before: string | null, after: string): ScenarioStep => ({
  kind: 'file',
  path,
  before,
  after,
})
