import type { AgentToolRegistry } from '@poietica/core-kernel'
import type { ConversationService } from '@poietica/feature-conversation/core-api'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import { AppError, SystemErrorCode } from '@poietica/foundation'
import { z } from 'zod'
import { AutomationDraft } from '../contract/entities'
import type { AutomationsService } from './service'

const json = (value: unknown): { text: string } => ({ text: JSON.stringify(value) })

/*
 * 三张 agent 工具的参数表。
 *
 * 提出来单独命名（而不是内联进 tools.register）是为了让 execute 的 params 有确切类型：
 * EngineToolSpec 的 `P` 泛型在对象字面量内联时推不到具体形状，execute 收到的是
 * z.output<z.ZodType> = unknown。命名之后 `z.output<typeof createParams>` 就是那张表的
 * 输出类型，参数错误仍由内核在调用前用同一张表校验。
 */
const createParams = AutomationDraft.omit({ workspaceId: true })
const updateParams = z.object({
  id: z.string().min(1).describe('任务 id'),
  patch: createParams.partial(),
})
const deleteParams = z.object({ id: z.string().min(1).describe('任务 id') })

function chinese(e: unknown): never {
  if (e instanceof AppError) throw e
  throw new AppError(SystemErrorCode.invalidParams, e instanceof Error ? e.message : String(e))
}

export function registerAgentTools(d: {
  readonly tools: AgentToolRegistry
  readonly service: AutomationsService
  readonly conversation: ConversationService
  readonly workspaces: WorkspacesService
}): void {
  const { conversation, service, tools, workspaces } = d

  tools.register({
    name: 'automation_list',
    label: '列出定时任务',
    description: 'List the scheduled automations in this workspace.',
    parameters: z.object({}),
    approval: 'read',
    async execute() {
      const rows = service.list().map((a) => ({
        id: a.id,
        title: a.title,
        schedule: a.schedule,
        enabled: a.enabled,
        nextRunAt: a.nextRunAt,
      }))
      return json(rows)
    },
  })

  tools.register({
    name: 'automation_create',
    label: '创建定时任务',
    description:
      'Create a scheduled automation in the workspace of the current thread. The workspace is taken from the thread; do not pass workspaceId.',
    parameters: createParams,
    approval: 'write',
    async execute(params: z.output<typeof createParams>, ctx) {
      try {
        const thread = conversation.get(ctx.sessionKey)
        if (thread === null) {
          throw new AppError(SystemErrorCode.notFound, '找不到当前对话所在的工作区')
        }
        workspaces.requireUsable(thread.workspaceId)
        return json(service.create({ ...params, workspaceId: thread.workspaceId }))
      } catch (e) {
        return chinese(e)
      }
    },
  })

  tools.register({
    name: 'automation_update',
    label: '修改定时任务',
    description: 'Update a scheduled automation by id.',
    parameters: updateParams,
    approval: 'write',
    async execute(params: z.output<typeof updateParams>) {
      try {
        return json(service.update(params.id, params.patch))
      } catch (e) {
        return chinese(e)
      }
    },
  })

  tools.register({
    name: 'automation_delete',
    label: '删除定时任务',
    description: 'Delete a scheduled automation by id.',
    parameters: deleteParams,
    approval: 'write',
    async execute(params: z.output<typeof deleteParams>) {
      try {
        await service.remove(params.id)
        return json({ id: params.id, removed: true })
      } catch (e) {
        return chinese(e)
      }
    },
  })
}
