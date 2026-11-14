import type { Logger } from '@poietica/foundation'
import type { WorkflowRecord, WorkflowService } from './workflows'

export interface WorkflowHandler {
  readonly kind: string
  /** 从 record.step 继续；handler 自己 advance/结束流程。 */
  resume(record: WorkflowRecord): void | Promise<void>
}

export interface ResumeWorkflowsOptions {
  readonly workflows: WorkflowService
  readonly handlers: readonly WorkflowHandler[]
  readonly logger: Logger
  readonly limit?: number
}

/**
 * 启动对账第 5 步：续跑所有 running 的持久工作流。
 * 返回成功交给 handler 的数量；没有 handler 或 handler 抛错的流程保持 running，下次启动再试。
 */
export async function resumeWorkflows(o: ResumeWorkflowsOptions): Promise<number> {
  const handlers = new Map(o.handlers.map((handler) => [handler.kind, handler]))
  let resumed = 0
  for (const record of o.workflows.unfinished(o.limit ?? 100)) {
    const handler = handlers.get(record.kind)
    if (handler === undefined) {
      o.logger.warn('workflow has no handler', { kind: record.kind, id: record.id, step: record.step })
      continue
    }
    try {
      /* 启动对账逐个续跑：一个 handler 就可能拉起引擎会话，串行是这条路径的资源上限。 */
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await handler.resume(record)
      resumed += 1
    } catch (error) {
      o.logger.warn('workflow resume failed', {
        kind: record.kind,
        id: record.id,
        step: record.step,
        error: String(error),
      })
    }
  }
  return resumed
}
