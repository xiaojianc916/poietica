import { defineCoreModule } from '@poietica/core-kernel'
import { JournalServiceToken } from '@poietica/feature-journal/core-api'
import { SettingsServiceToken } from '@poietica/feature-settings/core-api'
import { policyContract } from '../contract'
import { type PolicyCheckInput, PolicyServiceToken } from '../core-api'
import { createPolicyAudit } from './audit'
import { createPolicyGrantsRepository } from './grants'
import { migrations } from './migrations'
import { evaluateClassification, evaluatePolicy } from './policy'

/** 「本会话都批准」的有效期：一天之后重新问一次，长期授权不该无限期延续。 */
const GRANT_TTL_MS = 24 * 60 * 60 * 1000

export default defineCoreModule({
  id: 'policy',
  contract: policyContract,
  dependsOn: ['settings', 'journal'],
  migrations,
  settings: ['policy.preset'],
  setup(ctx) {
    ctx.services.get(SettingsServiceToken).register({
      key: 'policy.preset',
      label: '工具策略',
      description: '产品工具执行前的默认裁决档位',
      type: 'select',
      scopes: ['global'],
      defaultValue: 'auto-edit',
      options: [
        { value: 'ask', label: '每次询问' },
        { value: 'auto-edit', label: '工作区自动' },
        { value: 'full-access', label: '完全访问' },
      ],
      restart: false,
    })
    const grants = createPolicyGrantsRepository(ctx.db)
    const audit = createPolicyAudit({
      journal: ctx.services.get(JournalServiceToken),
      logger: ctx.logger,
      now: () => ctx.clock.now(),
    })

    const evaluate = (
      preset: Parameters<typeof evaluatePolicy>[0],
      tool: string,
      context?: Parameters<typeof evaluatePolicy>[2],
    ) => evaluatePolicy(preset, tool, context)

    /*
     * 「本会话已放行」是策略自己的最后一道覆盖：裁决要求询问，而这张会话已经批准过同一把工具 ——
     * 放行并写明是哪条规则放的行，审计里才看得出这次没问人是因为早先批准过。
     */
    const check = (input: PolicyCheckInput) => {
      const raw =
        input.classification === undefined
          ? evaluate(input.preset, input.toolName, input.context)
          : evaluateClassification(input.preset, input.classification, input.context)
      const decision =
        raw.action === 'ask' && grants.isGranted(input.sessionKey, input.toolName, ctx.clock.now())
          ? { ...raw, action: 'allow' as const, rule: 'policy.session_grant', reason: '本会话已放行该工具' }
          : raw
      audit.decided({
        sessionKey: input.sessionKey,
        toolName: input.toolName,
        decision,
        ...(input.context?.workspaceRoot === undefined ? {} : { workspaceRoot: input.context.workspaceRoot }),
        ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      })
      return decision
    }

    const service = {
      evaluate,
      evaluateClassification: (
        preset: Parameters<typeof evaluateClassification>[0],
        classification: Parameters<typeof evaluateClassification>[1],
        context?: Parameters<typeof evaluateClassification>[2],
      ) => evaluateClassification(preset, classification, context),
      check,
      grant: (input: { sessionKey: string; toolName: string }) => {
        const grant = grants.grant({ ...input, now: ctx.clock.now(), ttlMs: GRANT_TTL_MS })
        audit.granted(grant)
        return grant
      },
      grants: () => grants.list(ctx.clock.now()),
      revoke: (id: string) => {
        /* 先读再删：撤销之后那一行就没了，审计里的工具名与会话只能从这份快照拿 */
        const held = grants.find(id)
        const removed = grants.revoke(id)
        audit.revoked({ grantId: id, grant: held, removed })
        return removed
      },
      isGranted: (sessionKey: string, toolName: string) => grants.isGranted(sessionKey, toolName, ctx.clock.now()),
    }
    ctx.services.provide(PolicyServiceToken, service)

    ctx.rpc.handle('policy.check', ({ sessionKey, preset, toolName, context }) =>
      check({ sessionKey, preset, toolName, ...(context === undefined ? {} : { context }) }),
    )
    ctx.rpc.handle('policy.grants.list', () => ({ grants: [...service.grants()] }))
    ctx.rpc.handle('policy.grants.revoke', ({ grantId }) => ({ revoked: service.revoke(grantId) }))
  },
})
