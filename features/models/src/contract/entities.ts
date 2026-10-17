import {
  LoginIdentity as LoginIdentitySchema,
  LoginProvider as LoginProviderSchema,
  ModelInfo as ModelInfoSchema,
  ModelRef as ModelRefSchema,
  ModelRoleInfo as ModelRoleInfoSchema,
  ProviderInfo as ProviderInfoSchema,
} from '@poietica/engine'
import { z } from 'zod'

export const ModelInfo = ModelInfoSchema
export const ModelRef = ModelRefSchema
export const ProviderInfo = ProviderInfoSchema
export type ModelInfo = z.infer<typeof ModelInfoSchema>
export type ModelRef = z.infer<typeof ModelRefSchema>
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>
export const LoginProvider = LoginProviderSchema
export const LoginIdentity = LoginIdentitySchema
export type LoginProvider = z.infer<typeof LoginProviderSchema>
export type LoginIdentity = z.infer<typeof LoginIdentitySchema>
export const ModelRoleInfo = ModelRoleInfoSchema
export type ModelRoleInfo = z.infer<typeof ModelRoleInfoSchema>

/**
 * 一次订阅登录在路上的事：omp 的 OAuthLoginController 回调一条一条推给界面（Core 是 omp 所在的那台机器，回环回调落在它身上）。
 * `prompt` 要界面用 models.answerLogin 按 promptId 交回；`done` / `failed` 是终态，之后这一个 loginId 不再有事件。
 */
export const LoginEvent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('auth'),
    url: z.string(),
    launchUrl: z.string().nullable(),
    instructions: z.string().nullable(),
  }),
  z.object({ kind: z.literal('progress'), message: z.string() }),
  z.object({
    kind: z.literal('prompt'),
    promptId: z.string(),
    message: z.string(),
    placeholder: z.string().nullable(),
    secret: z.boolean(),
    allowEmpty: z.boolean(),
  }),
  z.object({ kind: z.literal('done'), identity: LoginIdentitySchema.nullable() }),
  z.object({ kind: z.literal('failed'), message: z.string() }),
])
export type LoginEvent = z.infer<typeof LoginEvent>

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
