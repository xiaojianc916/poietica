import { defineContract, defineMethod } from '@poietica/contract-kit'
import { z } from 'zod'
import { PolicyContext, PolicyDecision, PolicyGrant, PolicyPreset } from './entities'
import { policyErrors } from './errors'

export * from './entities'
export { policyErrors } from './errors'

export const policyContract = defineContract({
  id: 'policy',
  namespaces: ['policy'],
  methods: [
    defineMethod({
      name: 'policy.check',
      owner: 'core',
      params: z.object({ preset: PolicyPreset, toolName: z.string().min(1), context: PolicyContext.optional() }),
      result: PolicyDecision,
      description: '对一次工具执行做策略裁决（allow / ask / deny）',
    }),
    defineMethod({
      name: 'policy.grants',
      owner: 'core',
      params: z.object({}),
      result: z.object({ grants: z.array(PolicyGrant) }),
      description: '列出未过期的工具放行记录（授权管理页）',
    }),
    defineMethod({
      name: 'policy.revoke',
      owner: 'core',
      params: z.object({ grantId: z.string().min(1) }),
      result: z.object({ revoked: z.boolean() }),
      description: '撤销一条工具放行记录',
    }),
  ],
  notifications: [],
  errors: policyErrors,
})
