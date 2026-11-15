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
  /** 这次网络访问的目标（fetch / browser / MCP 远程服务器）：出口规则按它的主机名判定 */
  url: z.string().optional(),
})
export type PolicyContext = z.infer<typeof PolicyContext>

export const ToolClassification = z.object({
  category: ToolCategory,
  risk: Risk,
  checkpoint: z.boolean(),
})
export type ToolClassification = z.infer<typeof ToolClassification>

/**
 * 网络出口规则的裁决（§13.1 的「关闭 / 白名单 / 全部开放」）：命中的规则与拒绝原因单独交出来，
 * 审批卡片与审计不必再从 reason 里猜是白名单挡住还是预设关掉了网络。
 */
export const NetworkVerdict = z.object({
  action: PolicyAction,
  rule: z.string(),
  reason: z.string(),
  /** 解析出来的主机名；目标不是合法 URL 时缺席（此时规则是 `network.unparsed`） */
  host: z.string().optional(),
})
export type NetworkVerdict = z.infer<typeof NetworkVerdict>

export const PolicyDecision = z.object({
  action: PolicyAction,
  rule: z.string(),
  reason: z.string(),
  preset: PolicyPreset,
  classification: ToolClassification,
  /** 只在分类为 network 且给了 url 时出现 */
  network: NetworkVerdict.optional(),
})
export type PolicyDecision = z.infer<typeof PolicyDecision>

export const PolicyGrant = z.object({
  id: z.string().min(1),
  sessionKey: z.string().min(1),
  toolName: z.string().min(1),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
})
export type PolicyGrant = z.infer<typeof PolicyGrant>
