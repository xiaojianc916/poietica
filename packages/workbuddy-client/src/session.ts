import { WorkBuddyClientError } from './errors'
import { isRecord } from './guard'
import type { Auth, AuthStore, Plugin, ProviderConfig } from './plugin/types'
import { WorkBuddyAuthPlugin } from './plugin/workbuddy'
import type {
  WorkBuddyCheckin,
  WorkBuddyCheckinOutcome,
  WorkBuddyCredentials,
  WorkBuddyModel,
  WorkBuddySession,
  WorkBuddySessionHooks,
  WorkBuddySignIn,
  WorkBuddyUsage,
  WorkBuddyUsageWindow,
} from './types'

const OAUTH_METHOD = /browser/i

/** 插件 config() 填出来的那一份目录：provider.<id>.models 是静态表。 */
interface PluginConfig {
  provider?: Record<string, { models?: Record<string, ModelConfigShape> }>
}

/** 静态表里一个模型的声明（configModels 写出来的形状）。 */
interface ModelConfigShape {
  name?: string
  limit?: { context?: number; output?: number }
  modalities?: { input?: readonly string[]; output?: readonly string[] }
  reasoning?: boolean
  attachment?: boolean
  provider?: { npm?: string }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function credentialsOf(auth: Auth, base?: WorkBuddyCredentials): WorkBuddyCredentials {
  const type = auth.type === 'api' ? 'api' : (base?.type ?? 'oauth')
  const access = text(auth.access) || base?.access || ''
  const key = text(auth.key) || (type === 'api' ? text(auth.access) || base?.key || '' : '')
  return {
    type,
    access: type === 'api' ? key : access,
    refresh: text(auth.refresh) || base?.refresh || '',
    expires: numberValue(auth.expires) || base?.expires || 0,
    refreshExpiresAt: numberValue(auth.refreshExpiresAt) || base?.refreshExpiresAt || 0,
    uid: text(auth.uid) || base?.uid || '',
    accountId: text(auth.accountId) || base?.accountId || '',
    domain: text(auth.domain) || base?.domain || '',
    tokenType: text(auth.tokenType) || base?.tokenType || '',
    enterpriseId: text(auth.enterpriseId) || base?.enterpriseId || '',
    key,
  }
}

function vendorAuthOf(credentials: WorkBuddyCredentials): Auth {
  if (credentials.type === 'api') return { type: 'api', key: credentials.key }
  return {
    type: 'oauth',
    access: credentials.access,
    refresh: credentials.refresh,
    expires: credentials.expires,
    refreshExpiresAt: credentials.refreshExpiresAt,
    uid: credentials.uid,
    accountId: credentials.accountId,
    domain: credentials.domain,
    tokenType: credentials.tokenType,
    enterpriseId: credentials.enterpriseId,
  }
}

function stringsOf(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null
  const out = value.filter((item): item is string => typeof item === 'string')
  return out.length === 0 ? null : out
}

function usageWindowOf(value: Record<string, unknown>): WorkBuddyUsageWindow {
  const models = stringsOf(value.models)
  return {
    name: text(value.name) || 'Credits',
    used: numberOrNull(value.used),
    amount: numberOrNull(value.amount),
    limit: numberOrNull(value.limit),
    balance: numberOrNull(value.balance),
    unit: stringOrNull(value.unit),
    display: stringOrNull(value.display),
    resetsAt: stringOrNull(value.resetsAt),
    runsOutAt: stringOrNull(value.runsOutAt),
    span: numberOrNull(value.span),
    models,
    refused: value.refused === true,
    aside: value.aside === true,
    runsOut: numberOrNull(value.runsOut),
    notModels: stringsOf(value.notModels),
  }
}

function usageOf(value: Record<string, unknown>): WorkBuddyUsage {
  const windows = Array.isArray(value.windows)
    ? value.windows.filter(isRecord).map((window) => usageWindowOf(window))
    : []
  return {
    plan: stringOrNull(value.plan),
    windows,
    signIn: stringOrNull(value.signIn),
    error: stringOrNull(value.error),
  }
}

const OUTCOMES: Readonly<Record<string, true>> = {
  done: true,
  claimed: true,
  ineligible: true,
  inactive: true,
  failed: true,
}

function checkinOf(value: Record<string, unknown>): WorkBuddyCheckin {
  const outcome = text(value.outcome)
  return {
    outcome: (OUTCOMES[outcome] === true ? outcome : 'failed') as WorkBuddyCheckinOutcome,
    credit: numberOrNull(value.credit),
    streak: numberOrNull(value.streak),
    message: stringOrNull(value.message),
  }
}

function modelOf(id: string, model: ModelConfigShape): WorkBuddyModel {
  const context = model.limit?.context ?? 0
  const input = model.modalities?.input ?? []
  return {
    id,
    name: model.name ?? id,
    contextWindow: context > 0 ? context : null,
    reasoning: model.reasoning === true,
    vision: model.attachment === true || input.includes('image'),
    api: model.provider?.npm === '@ai-sdk/anthropic' ? 'messages' : 'chat',
  }
}

async function pluginFor(store: AuthStore): Promise<Plugin> {
  return await WorkBuddyAuthPlugin({ client: store })
}

/** 浏览器登录：插件自己轮询；调用方把 url 交给系统浏览器，再等 callback。 */
export async function startBrowserSignIn(): Promise<WorkBuddySignIn> {
  const plugin = await pluginFor({})
  const method = plugin.auth.methods.find((item) => item.type === 'oauth' && OAUTH_METHOD.test(item.label))
  const authorize = method?.authorize
  if (authorize === undefined) {
    throw new WorkBuddyClientError('login_failed', 'WorkBuddy 没有提供浏览器登录入口')
  }
  const started = await authorize()
  return {
    url: started.url,
    instructions: '在浏览器里完成 WorkBuddy 登录；完成后会自动回到这里。',
    async callback() {
      const result = await started.callback()
      if (result.type === 'failed') {
        throw new WorkBuddyClientError('login_failed', text(result.error) || 'WorkBuddy 登录失败')
      }
      return credentialsOf(result)
    },
  }
}

/** 目录来自插件自己的静态表；账户的实时表要请求上游，留给 usage 刷新。 */
export async function listModels(): Promise<readonly WorkBuddyModel[]> {
  const plugin = await pluginFor({})
  const config: PluginConfig = {}
  await plugin.config(config)
  const models: Record<string, ModelConfigShape> = config.provider?.workbuddy?.models ?? {}
  return Object.entries(models).map(([id, model]) => modelOf(id, model))
}

/** 建立一个账号的通道。插件刷新 token 时经 hooks.onUpdate 交回宿主。 */
export async function createSession(
  credentials: WorkBuddyCredentials,
  hooks: WorkBuddySessionHooks,
): Promise<WorkBuddySession> {
  let current = credentials
  const store: AuthStore = {
    auth: {
      async set(input) {
        current = credentialsOf(input.body, current)
        await hooks.onUpdate(current)
      },
    },
  }
  const plugin = await pluginFor(store)
  const getAuth = async (): Promise<Auth> => vendorAuthOf(current)
  const loader = await plugin.auth.loader(getAuth)
  if (loader.fetch === undefined) {
    throw new WorkBuddyClientError('not_signed_in', 'WorkBuddy 账号尚未登录')
  }
  const send = loader.fetch

  return {
    /*
     * 取消要一路传到上游：插件只认 init.signal（它把 Request 拆成 url / headers / body 三次用，
     * Request 自己的 signal 没人接管）。请求体仍交给插件从 Request 里读，这里只补 signal。
     */
    fetch: (request) => send(request, { signal: request.signal }),
    async usage() {
      try {
        return usageOf(await plugin.auth.usage(getAuth))
      } catch (cause) {
        throw new WorkBuddyClientError('usage_failed', '读取 WorkBuddy 积分失败', { cause })
      }
    },
    async checkin() {
      if (plugin.auth.checkin === undefined) {
        return { outcome: 'ineligible', credit: null, streak: null, message: '这一版 WorkBuddy 不提供签到' }
      }
      try {
        return checkinOf(await plugin.auth.checkin(getAuth))
      } catch (cause) {
        throw new WorkBuddyClientError('checkin_failed', 'WorkBuddy 签到失败', { cause })
      }
    },
    async validate() {
      const config: PluginConfig = {}
      await plugin.config(config)
      const provider = config.provider?.workbuddy
      if (provider === undefined) return
      try {
        await plugin.provider.models(provider as ProviderConfig, { auth: vendorAuthOf(current) })
      } catch (cause) {
        throw new WorkBuddyClientError('api_key_invalid', 'WorkBuddy 不接受这把 API Key', { cause })
      }
    },
  }
}
