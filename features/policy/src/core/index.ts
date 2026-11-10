import { defineCoreModule } from '@poietica/core-kernel'
import { policyContract } from '../contract'
import { PolicyServiceToken } from '../core-api'
import { evaluatePolicy } from './policy'

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
    }
    ctx.services.provide(PolicyServiceToken, service)
    ctx.rpc.handle('policy.check', ({ preset, toolName, context }) => evaluatePolicy(preset, toolName, context))
  },
})
