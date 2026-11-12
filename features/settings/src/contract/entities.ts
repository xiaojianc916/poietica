import { z } from 'zod'

export const SettingScope = z.enum(['global', 'project', 'thread'])
export type SettingScope = z.infer<typeof SettingScope>

export const SettingType = z.enum(['boolean', 'string', 'number', 'select', 'json'])
export type SettingType = z.infer<typeof SettingType>

export const SettingOption = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
  label: z.string(),
})
export type SettingOption = z.infer<typeof SettingOption>

export const SettingDefinition = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  type: SettingType,
  scopes: z.array(SettingScope).min(1),
  defaultValue: z.unknown(),
  options: z.array(SettingOption).optional(),
  sensitive: z.boolean().optional(),
  restart: z.boolean().optional(),
})
export type SettingDefinition = z.infer<typeof SettingDefinition>

export const SettingSource = z.enum(['thread', 'project', 'global', 'default'])
export type SettingSource = z.infer<typeof SettingSource>

export const SettingView = z.object({
  definition: SettingDefinition,
  value: z.unknown(),
  source: SettingSource,
  /** 敏感项只报是否配置过，不回报明文 */
  configured: z.boolean(),
})
export type SettingView = z.infer<typeof SettingView>

export const SettingContext = z.object({
  workspaceId: z.string().optional(),
  threadId: z.string().optional(),
})
export type SettingContext = z.infer<typeof SettingContext>

export const SettingSetParams = z.object({
  key: z.string().min(1),
  scope: SettingScope,
  scopeId: z.string().min(1),
  value: z.unknown(),
})
export type SettingSetParams = z.infer<typeof SettingSetParams>
