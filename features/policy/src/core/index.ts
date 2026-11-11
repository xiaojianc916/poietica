import { defineCoreModule } from '@poietica/core-kernel'
import { policyContract } from '../contract'
import { PolicyServiceToken } from '../core-api'
import { evaluateClassification, evaluatePolicy } from './policy'

export default defineCoreModule({
  id: 'policy',
  contract: policyContract,
  setup(ctx) {
    const service = {
      evaluate: (
        preset: Parameters<typeof evaluatePolicy>[0],
        tool: string,
        context?: Parameters<typeof evaluatePolicy>[2],
      ) => evaluatePolicy(preset, tool, context),
      evaluateClassification: (
        preset: Parameters<typeof evaluateClassification>[0],
        classification: Parameters<typeof evaluateClassification>[1],
        context?: Parameters<typeof evaluateClassification>[2],
      ) => evaluateClassification(preset, classification, context),
    }
    ctx.services.provide(PolicyServiceToken, service)
    ctx.rpc.handle('policy.check', ({ preset, toolName, context }) => evaluatePolicy(preset, toolName, context))
  },
})
