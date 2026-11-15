import type { AgentEvent } from '@poietica/agent-model'
import type { Clock, Logger } from '@poietica/foundation'

/** 只取启动对账要的两口；runs 不依赖 journal 包本身。 */
export interface ReconcileJournalPort {
  readTyped(
    threadId: string,
    agentId: string,
    types: readonly AgentEvent['type'][],
    limit?: number,
  ): readonly AgentEvent[]
  append(threadId: string, agentId: string, events: readonly AgentEvent[]): number
}

export interface ReconcileInterruptedRunsOptions {
  readonly threadIds: readonly string[]
  readonly journal: ReconcileJournalPort
  readonly clock: Clock
  readonly logger: Logger
}

function openRunIds(events: readonly AgentEvent[]): string[] {
  const open = new Set<string>()
  for (const event of events) {
    if (event.type === 'run.started' && event.runId !== undefined) open.add(event.runId)
    else if (event.type === 'run.completed') open.delete(event.runId)
  }
  return [...open]
}

/**
 * 启动对账第 1 步（§15.6）：Journal 里只有 `run.started`、没有终态的那些 Run，
 * 说明上次 Core 在运行途中退出；补一条 `run.completed { outcome: 'interrupted' }`，
 * 时间线冷读与后续 fold 才能把这一轮收口。Worker 崩溃由 EventRouter 在运行中处理，
 * 这里只补「没有 Worker 可问」的进程重启场景。
 */
export async function reconcileInterruptedRuns(o: ReconcileInterruptedRunsOptions): Promise<number> {
  let reconciled = 0
  for (const threadId of o.threadIds) {
    const events = o.journal.readTyped(threadId, 'main', ['run.started', 'run.completed'], 50_000)
    const open = openRunIds(events)
    if (open.length === 0) continue
    const at = new Date(o.clock.now()).toISOString()
    for (const runId of open) {
      try {
        o.journal.append(threadId, 'main', [
          {
            schema: 1,
            at,
            durability: 'committed',
            type: 'run.completed',
            runId,
            outcome: 'interrupted',
            endedAt: at,
          },
        ])
        reconciled += 1
      } catch (error) {
        o.logger.warn('interrupted run reconcile failed', { threadId, runId, error: String(error) })
      }
    }
  }
  return reconciled
}
