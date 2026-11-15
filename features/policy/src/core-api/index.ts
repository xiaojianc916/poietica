import { defineServiceToken } from '@poietica/foundation'
import type { PolicyContext, PolicyDecision, PolicyGrant, PolicyPreset, ToolClassification } from '../contract/entities'

export interface PolicyService {
  evaluate(preset: PolicyPreset, toolName: string, context?: PolicyContext): PolicyDecision
  evaluateClassification(
    preset: PolicyPreset,
    classification: ToolClassification,
    context?: PolicyContext,
  ): PolicyDecision
  /** 本会话放行某工具；默认 24 小时后过期（进程重启后仍生效）。 */
  grant(input: { readonly sessionKey: string; readonly toolName: string }): PolicyGrant
  grants(): readonly PolicyGrant[]
  revoke(grantId: string): boolean
  isGranted(sessionKey: string, toolName: string): boolean
}

export const PolicyServiceToken = defineServiceToken<PolicyService>('policy', 'PolicyService')
