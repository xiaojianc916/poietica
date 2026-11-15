import { defineCoreModule } from '@poietica/core-kernel'
import { SettingsServiceToken } from '@poietica/feature-settings/core-api'
import { policyContract } from '../contract'
import { PolicyServiceToken } from '../core-api'
import { createPolicyGrantsRepository } from './grants'
import { migrations } from './migrations'
import { evaluateClassification, evaluatePolicy } from './policy'

const GRANT_TTL_MS = 24 * 60 * 60 * 1000

export default defineCoreModule({
  id: 'policy',
  contract: policyContract,
  dependsOn: ['settings'],
  migrations,
  setup(ctx) {
    ctx.services.get(SettingsServiceToken).register({
      key: 'policy.preset',
      label: '工具策略',
      description: '产品工具执行前的默认裁决档位',
      type: 'select',
      scopes: ['global'],
      defaultValue: 'auto-edit',
      options: [
        { value: 'read-only', label: '只读' },
        { value: 'ask', label: '每次询问' },
        { value: 'auto-edit', label: '工作区自动' },
        { value: 'full-access', label: '完全访问' },
      ],
      restart: false,
    })
    const grants = createPolicyGrantsRepository(ctx.db)
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
      grant: (input: { sessionKey: string; toolName: string }) =>
        grants.grant({ ...input, now: ctx.clock.now(), ttlMs: GRANT_TTL_MS }),
      grants: () => grants.list(ctx.clock.now()),
      revoke: (id: string) => grants.revoke(id),
      isGranted: (sessionKey: string, toolName: string) => grants.isGranted(sessionKey, toolName, ctx.clock.now()),
    }
    ctx.services.provide(PolicyServiceToken, service)
    ctx.rpc.handle('policy.check', ({ preset, toolName, context }) => evaluatePolicy(preset, toolName, context))
    ctx.rpc.handle('policy.grants', () => ({ grants: [...service.grants()] }))
    ctx.rpc.handle('policy.revoke', ({ grantId }) => ({ revoked: service.revoke(grantId) }))
  },
})
