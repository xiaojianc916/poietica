import { defineServiceToken } from '@poietica/foundation'
import type { PolicyContext, PolicyDecision, PolicyPreset } from '../contract/entities'

export interface PolicyService {
  evaluate(preset: PolicyPreset, toolName: string, context?: PolicyContext): PolicyDecision
}

export const PolicyServiceToken = defineServiceToken<PolicyService>('policy', 'PolicyService')
