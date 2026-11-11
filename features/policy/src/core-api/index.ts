import { defineServiceToken } from '@poietica/foundation'
import type { PolicyContext, PolicyDecision, PolicyPreset, ToolClassification } from '../contract/entities'

export interface PolicyService {
  evaluate(preset: PolicyPreset, toolName: string, context?: PolicyContext): PolicyDecision
  evaluateClassification(
    preset: PolicyPreset,
    classification: ToolClassification,
    context?: PolicyContext,
  ): PolicyDecision
}

export const PolicyServiceToken = defineServiceToken<PolicyService>('policy', 'PolicyService')
