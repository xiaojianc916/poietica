import type {
  MarketplaceEntry as MarketplaceEntrySchema,
  McpServerInfo as McpServerInfoSchema,
  McpStatus as McpStatusSchema,
  PluginInfo as PluginInfoSchema,
  SkillInfo as SkillInfoSchema,
} from '@poietica/engine'
import { z } from 'zod'

/*
 * engine 把这些值对象导出为 **zod schema**（值），不是类型别名；contract 只引它们的推断类型，
 * 运行时校验用 engine 自己那份 schema（契约里直接 import 值使用）。
 */
export type SkillInfo = z.infer<typeof SkillInfoSchema>
export type McpServerInfo = z.infer<typeof McpServerInfoSchema>
export type McpStatus = z.infer<typeof McpStatusSchema>
export type PluginInfo = z.infer<typeof PluginInfoSchema>
export type MarketplaceEntry = z.infer<typeof MarketplaceEntrySchema>

export const SkillInstallSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('directory'), path: z.string().min(1) }),
  z.object({ kind: z.literal('zip'), path: z.string().min(1) }),
])
export type SkillInstallSource = z.infer<typeof SkillInstallSource>
