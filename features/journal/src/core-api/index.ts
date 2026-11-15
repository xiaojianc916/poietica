import type { AgentEvent } from '@poietica/agent-model'
import { defineServiceToken } from '@poietica/foundation'

/** Journal 的一个完整性分段；封段时记录校验和。 */
export interface JournalSegment {
  readonly id: number
  readonly state: 'open' | 'sealed' | 'corrupt'
  readonly startSeq: number
  readonly endSeq: number | null
  readonly events: number
  readonly bytes: number
  /** 校验失败的原因；正常段没有这个字段。 */
  readonly issue?: string
}

/** 审计查询的过滤条件：全部可选，给的越多范围越窄。 */
export interface JournalQueryOptions {
  /** 只读这一条线程；不给就是全部线程 */
  readonly threadId?: string
  readonly agentId?: string
  /** 载荷顶层字段的等值匹配（字符串 / 数字 / 布尔）；不存在的字段不匹配 */
  readonly fields?: Readonly<Record<string, string | number | boolean>>
  /** 升序取多少条；缺省 500 */
  readonly limit?: number
}

/** 跨线程读回来的一条事件：事件本体 + 它归属的线程（事件自己的 threadId 是写入时盖上的同一份）。 */
export interface JournaledEvent {
  readonly threadId: string
  readonly event: AgentEvent
}

export interface JournalIntegrity {
  readonly ok: boolean
  readonly gaps: readonly number[]
  readonly segments: readonly JournalSegment[]
  readonly corruptSegments: readonly number[]
}

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
  /**
   * 跨线程按事件类型读（审计视图用），可以再按载荷顶层的标量字段等值过滤（工具名、风险等级、工作区……）。
   * 过滤在 SQL 里做：审计要看的是「这一周哪些高风险裁决被拒绝过」，把全部事件读进内存再筛不算数。
   * 返回按 (threadId, seq) 升序。
   */
  query(types: readonly AgentEvent['type'][], options?: JournalQueryOptions): readonly JournaledEvent[]
  latestSeq(threadId: string, agentId: string): number
  /** 启动对账：seq 是否从 1 连续，以及每个分段的计数/校验和是否对得上。 */
  integrity(threadId: string, agentId: string): JournalIntegrity
  /** 线程删除时一起清掉；返回删掉的行数。 */
  clear(threadId: string): number
}

export const JournalServiceToken = defineServiceToken<JournalService>('journal', 'JournalService')
