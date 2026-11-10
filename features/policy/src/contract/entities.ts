import { z } from 'zod'

export const PolicyPreset = z.enum(['read-only', 'ask', 'auto-edit', 'full-access'])
export type PolicyPreset = z.infer<typeof PolicyPreset>

export const ToolCategory = z.enum([
  'exec',
  'code.eval',
  'file.write',
  'file.read',
  'network',
  'agent',
  'mcp',
  'plugin',
  'meta',
  'product',
  'unknown',
])
export type ToolCategory = z.infer<typeof ToolCategory>

export const Risk = z.enum(['none', 'low', 'medium', 'high'])
export type Risk = z.infer<typeof Risk>

export const PolicyAction = z.enum(['allow', 'ask', 'deny'])
export type PolicyAction = z.infer<typeof PolicyAction>

export const PolicyContext = z.object({
  workspaceRoot: z.string().optional(),
  command: z.string().optional(),
  paths: z.array(z.string()).optional(),
})
export type PolicyContext = z.infer<typeof PolicyContext>

export const ToolClassification = z.object({
  category: ToolCategory,
  risk: Risk,
  checkpoint: z.boolean(),
})
export type ToolClassification = z.infer<typeof ToolClassification>

export const PolicyDecision = z.object({
  action: PolicyAction,
  rule: z.string(),
  reason: z.string(),
  preset: PolicyPreset,
  classification: ToolClassification,
})
export type PolicyDecision = z.infer<typeof PolicyDecision>
