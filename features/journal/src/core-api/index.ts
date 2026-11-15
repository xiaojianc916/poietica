import type { AgentEvent } from '@poietica/agent-model'
import { defineServiceToken } from '@poietica/foundation'

/**
 * Thread Journal（ADR-005）：只存 omp 不知道的产品记录，按 (threadId, agentId) 单调编号。
 * 对话正文仍以 omp 会话文件为准；Journal 不复制它。
 */
export interface JournalService {
  /** 追加 committed 事件；返回最后一条的 seq。瞬态事件被忽略。 */
  append(threadId: string, agentId: string, events: readonly AgentEvent[]): number
  /** 追加并给 committed 事件盖上 threadId/agentId/seq；返回同一顺序的事件（瞬态只盖归属）。 */
  appendAndStamp(threadId: string, agentId: string, events: readonly AgentEvent[]): readonly AgentEvent[]
  /** 读 afterSeq 之后的事件（升序）；limit 缺省 500。 */
  read(threadId: string, agentId: string, afterSeq: number, limit?: number): readonly AgentEvent[]
  /** 按事件类型读（启动对账用），升序；limit 缺省 5000。 */
  readTyped(
    threadId: string,
    agentId: string,
    types: readonly AgentEvent['type'][],
    limit?: number,
  ): readonly AgentEvent[]
  latestSeq(threadId: string, agentId: string): number
  /** 启动对账：seq 是否从 1 连续；gaps 是缺失的序号。 */
  integrity(threadId: string, agentId: string): { readonly ok: boolean; readonly gaps: readonly number[] }
  /** 线程删除时一起清掉；返回删掉的行数。 */
  clear(threadId: string): number
}

export const JournalServiceToken = defineServiceToken<JournalService>('journal', 'JournalService')
