import { defineContract, defineMethod } from '@poietica/contract-kit'
import { z } from 'zod'
import { PolicyContext, PolicyDecision, PolicyGrant, PolicyPreset } from './entities'
import { policyErrors } from './errors'

export * from './entities'
export { policyErrors } from './errors'

/**
 * 执行安全平面（架构设计 §13.1）。方法名与事实归属对齐：
 * 裁决归 `policy.check`，授权记录归 `policy.grants.*` —— 记录是产品事实，撤销是产品动作，
 * 两者都不属于任何一次工具执行。
 */
export const policyContract = defineContract({
  id: 'policy',
  namespaces: ['policy'],
  methods: [
    defineMethod({
      name: 'policy.check',
      owner: 'core',
      params: z.object({
        sessionKey: z.string().min(1),
        preset: PolicyPreset,
        toolName: z.string().min(1),
        context: PolicyContext.optional(),
      }),
      result: PolicyDecision,
      description: '对一次工具执行做策略裁决（allow / ask / deny），并把裁决写进 Journal',
    }),
    defineMethod({
      name: 'policy.grants.list',
      owner: 'core',
      params: z.object({}),
      result: z.object({ grants: z.array(PolicyGrant) }),
      description: '列出未过期的工具放行记录（授权管理页）',
    }),
    defineMethod({
      name: 'policy.grants.revoke',
      owner: 'core',
      params: z.object({ grantId: z.string().min(1) }),
      result: z.object({ revoked: z.boolean() }),
      description: '撤销一条工具放行记录，并把撤销写进 Journal',
    }),
  ],
  notifications: [],
  errors: policyErrors,
})
