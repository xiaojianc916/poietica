/*
 * 上游插件的类型收窄。插件本体是 MIT 的纯 JS（workbuddy.mjs，约 3800 行），
 * 这里只声明适配层真正用到的面；插件升级时按实际用到的字段核对。
 */

export interface VendorAuth {
  readonly type?: string
  readonly access?: string
  readonly refresh?: string
  readonly expires?: number
  readonly refreshExpiresAt?: number
  readonly uid?: string
  readonly accountId?: string
  readonly domain?: string
  readonly tokenType?: string
  readonly enterpriseId?: string
  readonly key?: string
  readonly source?: string
  readonly [key: string]: unknown
}

export interface VendorAuthStore {
  readonly auth?: {
    readonly set?: (input: {
      readonly path: { readonly id: string }
      readonly body: VendorAuth
    }) => Promise<void> | void
  }
}

export interface VendorModelConfig {
  readonly name?: string
  readonly limit?: { readonly context?: number; readonly output?: number }
  readonly tool_call?: boolean
  readonly attachment?: boolean
  readonly modalities?: { readonly input?: readonly string[]; readonly output?: readonly string[] }
  readonly reasoning?: boolean
  readonly provider?: { readonly npm?: string }
  readonly [key: string]: unknown
}

export interface VendorProviderConfig {
  readonly name?: string
  readonly api?: string
  readonly models?: Record<string, VendorModelConfig>
  readonly [key: string]: unknown
}

export interface VendorConfig {
  readonly provider?: Record<string, VendorProviderConfig>
  readonly [key: string]: unknown
}

export interface VendorLoader {
  readonly baseURL: string
  readonly apiKey: string
  readonly fetch?: (input: Request | string, init?: RequestInit) => Promise<Response>
}

export interface VendorOAuthSignIn {
  readonly url: string
  readonly instructions: string
  readonly method: string
  callback(): Promise<VendorAuth>
}

export interface VendorOAuthMethod {
  readonly type: 'oauth'
  readonly label: string
  authorize(): Promise<VendorOAuthSignIn>
}

export interface VendorApiKeyMethod {
  readonly type: 'api'
  readonly label: string
  readonly placeholder?: string
}

export interface VendorPlugin {
  config(config: VendorConfig): Promise<void> | void
  readonly provider: {
    readonly id: string
    models(provider: VendorProviderConfig, input: { readonly auth: VendorAuth }): Promise<Record<string, unknown>>
  }
  readonly auth: {
    readonly loader: (getAuth: () => Promise<VendorAuth | undefined>) => Promise<VendorLoader>
    readonly usage: (getAuth: () => Promise<VendorAuth | undefined>) => Promise<Record<string, unknown>>
    readonly checkin?: (getAuth: () => Promise<VendorAuth | undefined>) => Promise<Record<string, unknown>>
    readonly methods: readonly (VendorOAuthMethod | VendorApiKeyMethod)[]
  }
}

export declare function WorkBuddyAuthPlugin(input: {
  readonly client: VendorAuthStore
  readonly magpie?: unknown
}): Promise<VendorPlugin>

export declare function WorkBuddyAIAuthPlugin(input: {
  readonly client: VendorAuthStore
  readonly magpie?: unknown
}): Promise<VendorPlugin>
