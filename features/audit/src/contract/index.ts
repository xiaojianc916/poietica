import { defineContract, defineMethod } from '@poietica/contract-kit'
import { z } from 'zod'
import { AuditEntry, AuditFilter } from './entities'
import { auditErrors } from './errors'

export * from './entities'
export { auditErrors } from './errors'

/**
 * 审计视图（§13.5）：事实源是 Journal，这里只做「按类别 / 工具 / 风险 / 工作区」的读取与导出，
 * 不另存一份副本。threadId 不给就是跨线程看 —— 「这一周哪些高风险裁决被拒绝过」是审计的常见问法。
 */
export const auditContract = defineContract({
  id: 'audit',
  namespaces: ['audit'],
  methods: [
    defineMethod({
      name: 'audit.query',
      owner: 'core',
      params: AuditFilter,
      result: z.object({ entries: z.array(AuditEntry) }),
      description: '按线程 / 类别 / 工具 / 风险等级 / 工作区读审计事件；事实源是 Journal，不另存副本',
    }),
    defineMethod({
      name: 'audit.export',
      owner: 'core',
      params: AuditFilter,
      result: z.object({ count: z.number().int(), json: z.string() }),
      description: '把同一份审计查询导出成 JSON 文本（复制/保存给支持或合规审查）',
    }),
  ],
  notifications: [],
  errors: auditErrors,
})
