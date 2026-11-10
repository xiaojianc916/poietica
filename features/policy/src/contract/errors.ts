import { defineErrors } from '@poietica/contract-kit'

export const policyErrors = defineErrors('policy', {
  invalid_context: '策略上下文无效',
})
