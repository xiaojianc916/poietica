/*
 * WorkBuddy 协议层用到的形状。业务侧只经 src/index.ts；这里只放「协议本身长什么样」，
 * 不放 Poietica 的 RPC / 数据库概念。
 */

/** 一个站点（国内版 / 国际版）的常量表。 */
export interface Site {
  readonly id: string
  readonly name: string
  readonly endpoint: string
  readonly authID: string
  readonly platform: string
  readonly ai: boolean
  readonly app: string
  readonly cli: string
  readonly appName: string
  readonly runtime?: string
  readonly keys: string
  readonly models: readonly ModelSpec[]
  readonly messages?: boolean
  readonly noImages?: RegExp
}

/** 静态模型表的一行：[id, 显示名, 上下文, 思考档位]。 */
export type ModelSpec = readonly [string, string, number] | readonly [string, string, number, readonly string[]]

/** 一份账号凭据（浏览器登录拿到的，或刷新出来的）。 */
export interface Auth {
  type?: string
  access?: string
  refresh?: string
  expires?: number
  refreshExpiresAt?: number
  uid?: string
  accountId?: string
  domain?: string
  tokenType?: string
  enterpriseId?: string
  key?: string
  source?: string
  user?: string
  plan?: string
  [key: string]: unknown
}

/** WorkBuddy 签发的令牌（登录或刷新返回）。 */
export interface TokenGrant {
  accessToken?: string
  refreshToken?: string
  domain?: string
  tokenType?: string
  expiresAt?: number
  expiresIn?: number
  refreshExpiresAt?: number
  refreshExpiresIn?: number
  [key: string]: unknown
}

/** 插件的 `{code, msg, data}` 信封。 */
export interface Envelope {
  code?: number | string
  msg?: string
  message?: string
  error?: { message?: string }
  data?: unknown
  [key: string]: unknown
}

/** 消息内容里的一块（文本、图片、思考块、工具结果…），插件只读 type 与 text/signature。 */
export interface ContentPart {
  type?: string
  text?: string
  signature?: string
  [key: string]: unknown
}

/** 一个工具的 function：声明的名字与参数，或一次调用的名字与实参。 */
export interface ToolFunction {
  name?: string
  parameters?: JsonSchema
  arguments?: unknown
  [key: string]: unknown
}

/** 一个工具调用：assistant 的 tool_calls 里的一项，流式回复的 delta 里也是它。 */
export interface ToolCall {
  id?: string
  function?: ToolFunction
  [key: string]: unknown
}

/** 一份工具声明：chat 的 tools 里的一项（OpenAI 形状，或 Anthropic 的 input_schema）。 */
export interface ToolSpec {
  type?: string
  function?: ToolFunction
  name?: string
  input_schema?: JsonSchema
  [key: string]: unknown
}

/** tool_choice 的对象形状（OpenAI 客户端给的），normalizeToolChoice 读它。 */
export interface ToolChoice {
  type?: string
  function?: ToolFunction
  [key: string]: unknown
}

/** 一份回复里的一个 choice：非流式的 message，或流式的 delta。 */
export interface ChunkChoice {
  message?: ChatMessage
  delta?: ChatMessage
  finish_reason?: string | null
  [key: string]: unknown
}

/** 一份 chat 回复：非流式的一个 JSON 体，或 SSE 里每个 data 的数据。 */
export interface Chunk {
  choices?: readonly ChunkChoice[]
  usage?: unknown
  [key: string]: unknown
}

/** reasoning_details 里的一项（OpenRouter 形状）：text 或 summary 就是要的文字。 */
export interface ReasoningDetail {
  text?: string
  summary?: string
  [key: string]: unknown
}

/** 一个聊天的请求体（OpenAI 形状，插件只读写其中若干格）。 */
export interface Chat {
  model?: string
  messages?: ChatMessage[]
  tools?: ToolSpec[]
  tool_choice?: string | ToolChoice
  system?: unknown
  reasoning_effort?: string
  reasoning?: { effort?: string }
  max_tokens?: number
  max_completion_tokens?: number
  stream?: boolean
  [key: string]: unknown
}

export interface ChatMessage {
  role?: string
  content?: string | ContentPart[]
  tool_calls?: readonly ToolCall[]
  name?: string
  reasoning_content?: string
  reasoning_details?: readonly ReasoningDetail[]
  [key: string]: unknown
}

/** 一个模型在目录里的样子（provider.models 的取值）。 */
export interface ModelInfo {
  id: string
  providerID: string
  name: string
  api: { id: string; url: string; npm: string }
  status: string
  headers: Record<string, string>
  options: Record<string, unknown>
  cost: { input: number; output: number; cache: { read: number; write: number } }
  limit: { context: number; output: number }
  capabilities: Record<string, unknown>
  release_date: string
  variants: Record<string, unknown>
  free: boolean
  rate: number
  rateWas: number
  [key: string]: unknown
}

/** 实时目录里的一行（/v3/config 的 models，按账号裁剪过）。 */
export interface ModelItem {
  id: string
  name?: string
  context?: number
  output?: number
  efforts?: readonly string[]
  images?: boolean
  free?: boolean
  rate?: number
  rateWas?: number
  effort?: string
}

export type ModelList = readonly ModelItem[]

/** 一次登录：浏览器授权页 + 等回调。 */
export interface SignIn {
  readonly url: string
  readonly instructions: string
  readonly method: string
  callback(): Promise<Auth & { type: string; error?: string }>
}

/** 额度卡片里的一格。 */
export interface UsageWindow {
  name: string
  used?: number
  amount?: number
  limit?: number
  balance?: number
  unit?: string
  display?: string
  resetsAt?: string
  runsOutAt?: string
  runsOut?: number
  span?: number
  models?: readonly string[]
  refused?: boolean
  aside?: boolean
  notModels?: readonly string[]
  [key: string]: unknown
}

/** 额度卡片的整体形状。 */
export interface Usage {
  plan?: string
  windows: UsageWindow[]
  signIn?: string
  error?: string
  [key: string]: unknown
}

/** 一个限时活动（config 的 modelPromotions 里的一条）。 */
export interface Promotion {
  kind?: string
  enabled?: boolean
  modelIds?: readonly string[]
  discount?: { factor?: number; discountedCredits?: string | number }
  schedule?: { validFrom?: string; validUntil?: string; daily?: readonly unknown[] }
  [key: string]: unknown
}

/** /v3/config 里一个模型的详情（比实时目录多 reasoning 的细节）。 */
export interface ModelDetail {
  id?: string
  credits?: string | number
  supportsReasoning?: boolean
  reasoning?: { supportedEfforts?: readonly string[]; effort?: string; defaultEffort?: string }
  [key: string]: unknown
}

/** billing 接口里一个套餐包的一行（usageOf / packagesOf / runsOutOf 都读它）。 */
export interface PackageRow {
  PackageCode?: string
  CapacityType?: string
  CycleTotalCapacity?: string | number | null
  CycleUsedCapacity?: string | number | null
  CycleRemainCapacity?: string | number | null
  CycleStartTime?: string
  CycleEndTime?: string
  DeductionEndTime?: string | number
  ExpiredTime?: string | number
  [key: string]: unknown
}

/** 签到结果。 */
export interface Checkin {
  outcome: string
  credit?: number
  streak?: number
  /** 上游可能明确给一个「没有消息」，所以这里也接受 undefined。 */
  message?: string | undefined
  [key: string]: unknown
}

/** 插件的 auth.set：把刷新出来的令牌交回宿主落库。 */
export interface AuthStore {
  readonly auth?: {
    readonly set?: (input: { readonly path: { readonly id: string }; readonly body: Auth }) => Promise<void> | void
  }
}

/** 宿主自己的会话 id（插件用它派生 X-Conversation-ID）。 */
export interface ChatHeadersInput {
  readonly model?: { readonly providerID?: string }
  readonly provider?: { readonly info?: { readonly id?: string } }
  readonly sessionID?: string
}

/** 插件本体。 */
export interface Plugin {
  config(config: { provider?: Record<string, ProviderConfig> }): Promise<void> | void
  readonly 'chat.headers'?: (
    input: ChatHeadersInput | undefined,
    output: { readonly headers: Record<string, string> },
  ) => Promise<void> | void
  readonly provider: {
    readonly id: string
    models(provider: ProviderConfig, input: { readonly auth?: Auth }): Promise<Record<string, unknown> | undefined>
  }
  readonly auth: {
    readonly loader: (getAuth: () => Promise<Auth | undefined>) => Promise<Loader>
    readonly usage: (getAuth: () => Promise<Auth | undefined>) => Promise<Usage>
    readonly checkin?: (getAuth: () => Promise<Auth | undefined>) => Promise<Checkin>
    readonly methods: readonly AuthMethod[]
    readonly options?: readonly unknown[]
    readonly refreshLead?: number
    readonly refresh?: (auth: Auth) => Promise<Auth | undefined>
  }
}

export interface ProviderConfig {
  name?: string
  api?: string
  npm?: string
  models?: Record<string, unknown>
  [key: string]: unknown
}

export interface Loader {
  readonly baseURL: string
  readonly apiKey: string
  readonly fetch?: (input: Request | string, init?: RequestInit) => Promise<Response>
}

export interface OAuthMethod {
  readonly type: string
  readonly label: string
  authorize?(): Promise<SignIn>
}

export interface ApiKeyMethod {
  readonly type: string
  readonly label: string
  readonly placeholder?: string | undefined
  /** 收 API Key 的那条路没有授权页；留一格，联合类型上也能安全读 authorize。 */
  readonly authorize?: undefined
}

export type AuthMethod = OAuthMethod | ApiKeyMethod

/**
 * 一份 JSON Schema，只到插件改写它时需要的深度。
 * 它本来就是任意的 JSON（模型给的、MCP 工具给的），所以字段全可选、可再嵌套。
 */
export interface JsonSchema {
  type?: string | readonly string[]
  enum?: unknown
  pattern?: string
  items?: JsonSchema | readonly JsonSchema[]
  additionalItems?: unknown
  properties?: Record<string, JsonSchema>
  patternProperties?: Record<string, JsonSchema>
  $defs?: Record<string, JsonSchema>
  definitions?: Record<string, JsonSchema>
  dependentSchemas?: Record<string, JsonSchema>
  anyOf?: readonly JsonSchema[]
  oneOf?: readonly JsonSchema[]
  allOf?: readonly JsonSchema[]
  prefixItems?: readonly JsonSchema[]
  additionalProperties?: boolean | JsonSchema
  unevaluatedProperties?: boolean | JsonSchema
  unevaluatedItems?: unknown
  contains?: JsonSchema
  not?: JsonSchema
  if?: JsonSchema
  then?: JsonSchema
  else?: JsonSchema
  propertyNames?: JsonSchema
  $ref?: string
  description?: string
  required?: readonly string[]
  [key: string]: unknown
}

/**
 * catch 里接住的东西。插件一路上抛的都是带这几格的 Error：WBError 带 code/status/said，
 * 刷新失败那次还带 bare，meter 抛的带 invalidToken / unreadable。
 */
export interface Thrown {
  readonly message?: string
  readonly code?: number | string
  readonly status?: number
  readonly said?: string
  readonly bare?: boolean
  readonly invalidToken?: boolean
  readonly unreadable?: boolean
  readonly name?: string
}

/** 上游错误体的形状：几种写法都见过，读的时候挨个试。 */
export interface ErrorEnvelope {
  error?:
    | string
    | {
        message?: string
        code?: string | number
        internal_code?: string | number
        data?: { code?: string | number; msg?: string }
      }
  code?: string | number
  msg?: string
  message?: string
  internal_code?: string | number
  data?: { code?: string | number; msg?: string }
  [key: string]: unknown
}

/** 记账账本里的一行（magpie 的 usage.jsonl）。 */
export interface LedgerRow {
  t?: string
  provider?: string
  providerAccount?: string
  model?: string
  status?: number | string
  in?: number
  cache_read?: number
  out?: number
  err?: string
  source?: string
  [key: string]: unknown
}
