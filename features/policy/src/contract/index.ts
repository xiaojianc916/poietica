import { defineContract, defineMethod } from '@poietica/contract-kit'
import { z } from 'zod'
import { PolicyContext, PolicyDecision, PolicyPreset } from './entities'
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
  ],
  notifications: [],
  errors: policyErrors,
})
