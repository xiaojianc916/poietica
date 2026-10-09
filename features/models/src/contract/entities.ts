import {
  ModelInfo as ModelInfoSchema,
  ModelRef as ModelRefSchema,
  ProviderInfo as ProviderInfoSchema,
} from '@poietica/engine'
import { z } from 'zod'

/* 值 + 同名类型：与 platform 的 entities.ts 同一个写法 */
export const ModelInfo = ModelInfoSchema
export const ModelRef = ModelRefSchema
export const ProviderInfo = ProviderInfoSchema
export type ModelInfo = z.infer<typeof ModelInfoSchema>
export type ModelRef = z.infer<typeof ModelRefSchema>
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>

export const CustomProviderDef = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  name: z.string().min(1).max(60),
  api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']),
  baseUrl: z.url().refine((u) => /^https?:\/\//.test(u), '必须是 http 或 https 地址'),
  models: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        contextWindow: z.number().int().positive().nullable(),
        reasoning: z.boolean(),
        vision: z.boolean(),
      }),
    )
    .min(1),
})
export type CustomProviderDef = z.infer<typeof CustomProviderDef>

export const ApiKeyInput = z.object({ provider: z.string().min(1), apiKey: z.string().trim().min(8).max(512) })
export type ApiKeyInput = z.infer<typeof ApiKeyInput>
