import { defineContract, defineMethod } from '@poietica/contract-kit'
import { z } from 'zod'
import { AuditEntry, AuditKind } from './entities'
import { auditErrors } from './errors'

export * from './entities'
export { auditErrors } from './errors'

export const auditContract = defineContract({
  id: 'audit',
  namespaces: ['audit'],
  methods: [
    defineMethod({
      name: 'audit.query',
      owner: 'core',
      params: z.object({
        threadId: z.string().min(1),
        kinds: z.array(AuditKind).optional(),
        limit: z.number().int().min(1).max(5_000).optional(),
      }),
      result: z.object({ entries: z.array(AuditEntry) }),
      description: '按线程读审计事件（策略裁决 / 审批 / 检查点 / 运行终态）；事实源是 Journal，不另存副本',
    }),
  ],
  notifications: [],
  errors: auditErrors,
})
