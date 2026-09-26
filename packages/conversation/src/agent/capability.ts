import type { SessionConfigControl } from './config'
import type { AgentToolkit } from './toolkit'

/* read 与 select 交回同一张表：改一项可能增删另一项；能力属于 agent，不属于某条会话。 */

export interface AgentCapabilityPort {
  readonly read: () => Promise<readonly SessionConfigControl[]>
  /* 收整个 control 而不是它的 id：认出某一格靠 purpose，id 是 agent 自己起的名字。 */
  readonly select: (
    control: SessionConfigControl,
    value: string,
  ) => Promise<readonly SessionConfigControl[]>
  readonly subscribe: (handler: () => void) => () => void
  /* 名册按会话答；null 只用于入口那一格。 */
  readonly readToolkit: (threadId: string | null) => Promise<AgentToolkit>
}
