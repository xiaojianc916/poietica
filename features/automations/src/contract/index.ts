import { defineContract, defineMethod, defineNotification } from '@poietica/contract-kit'
import { z } from 'zod'
import {
  Automation,
  AutomationAttention,
  AutomationDraft,
  AutomationPatch,
  AutomationRun,
  Schedule,
  ScheduleProblem,
} from './entities'
import { automationsErrors } from './errors'

export * from './entities'
export { automationsErrors } from './errors'

const empty = z.object({})

export const automationsContract = defineContract({
  id: 'automations',
  namespaces: ['automations'],
  methods: [
    defineMethod({
      name: 'automations.list',
      owner: 'core',
      params: empty,
      result: z.object({ automations: z.array(Automation) }),
      description: '列出全部定时任务',
    }),
    defineMethod({
      name: 'automations.get',
      owner: 'core',
      params: z.object({ automationId: z.string().min(1) }),
      result: Automation,
      description: '读一个定时任务（不存在 → not_found）',
    }),
    defineMethod({
      name: 'automations.create',
      owner: 'core',
      params: AutomationDraft,
      result: Automation,
      description: '创建定时任务',
    }),
    defineMethod({
      name: 'automations.update',
      owner: 'core',
      params: z.object({ automationId: z.string().min(1), patch: AutomationPatch }),
      result: Automation,
      description: '更新定时任务',
    }),
    defineMethod({
      name: 'automations.remove',
      owner: 'core',
      params: z.object({ automationId: z.string().min(1) }),
      result: empty,
      description: '删除定时任务（运行先取消；不删除它创建过的线程）',
    }),
    defineMethod({
      name: 'automations.setEnabled',
      owner: 'core',
      params: z.object({ automationId: z.string().min(1), enabled: z.boolean() }),
      result: Automation,
      description: '启用或暂停定时任务',
    }),
    defineMethod({
      name: 'automations.runNow',
      owner: 'core',
      params: z.object({ automationId: z.string().min(1) }),
      result: AutomationRun,
      description: '手动运行一次（已在运行 → already_running）',
    }),
    defineMethod({
      name: 'automations.cancelRun',
      owner: 'core',
      params: z.object({ runId: z.string().min(1) }),
      result: empty,
      description: '取消一次运行（不存在 → run_not_found）',
    }),
    defineMethod({
      name: 'automations.runs',
      owner: 'core',
      params: z.object({ automationId: z.string().min(1), limit: z.number().int().positive() }),
      result: z.object({ runs: z.array(AutomationRun) }),
      description: '读运行历史（最近的在前）',
    }),
    defineMethod({
      name: 'automations.previewSchedule',
      owner: 'core',
      params: z.object({ schedule: Schedule, count: z.number().int().positive() }),
      result: z.object({ times: z.array(z.number().int()), problem: ScheduleProblem.nullable() }),
      description: '预览未来若干次运行时间',
    }),
  ],
  notifications: [
    defineNotification({
      name: 'automations.changed',
      owner: 'core',
      params: empty,
      description: '任务定义变化',
    }),
    defineNotification({
      name: 'automations.runUpdated',
      owner: 'core',
      params: AutomationRun,
      description: '一次运行的状态变化',
    }),
    defineNotification({
      name: 'automations.attention',
      owner: 'core',
      params: AutomationAttention,
      description: '一次运行需要告诉用户（按任务的通知策略判定）：UI 转成系统通知',
    }),
  ],
  errors: automationsErrors,
})
