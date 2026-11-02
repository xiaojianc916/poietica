/*
 * WorkBuddy 客户端适配层对外的类型。这里不认识 Poietica 的 RPC、数据库或界面：
 * 凭据、积分窗口、签到结果都是上游插件给的形状，只收窄，不加工。
 */

export type WorkBuddyAuthType = 'oauth' | 'api'

/** 一份账号凭据。`api` 型只用 `key`；`oauth` 型用 access/refresh 与过期时间。 */
export interface WorkBuddyCredentials {
  readonly type: WorkBuddyAuthType
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly refreshExpiresAt: number
  readonly uid: string
  readonly accountId: string
  readonly domain: string
  readonly tokenType: string
  readonly enterpriseId: string
  readonly key: string
}

export interface WorkBuddyUsageWindow {
  readonly name: string
  readonly used: number | null
  readonly amount: number | null
  readonly limit: number | null
  readonly balance: number | null
  readonly unit: string | null
  readonly display: string | null
  readonly resetsAt: string | null
  readonly runsOutAt: string | null
  readonly span: number | null
  readonly models: readonly string[] | null
  readonly refused: boolean
  /** 这一格只是摆着看：另一格才决定账号停不停（0.2.13 把套餐积分与额外积分拆开）。 */
  readonly aside: boolean
  /** 这一格里最早到期的那批积分数；null = 上游没给。 */
  readonly runsOut: number | null
  /** 扣不动这一格积分的模型 id；null = 上游没给。 */
  readonly notModels: readonly string[] | null
}

export interface WorkBuddyUsage {
  readonly plan: string | null
  readonly windows: readonly WorkBuddyUsageWindow[]
  /** upstream 的 signIn：kept / renewed / expired */
  readonly signIn: string | null
  readonly error: string | null
}

export type WorkBuddyCheckinOutcome = 'done' | 'claimed' | 'ineligible' | 'inactive' | 'failed'

export interface WorkBuddyCheckin {
  readonly outcome: WorkBuddyCheckinOutcome
  readonly credit: number | null
  readonly streak: number | null
  readonly message: string | null
}

export interface WorkBuddyModel {
  readonly id: string
  readonly name: string
  readonly contextWindow: number | null
  readonly reasoning: boolean
  readonly vision: boolean
  /** WorkBuddy 用哪个协议服务这个模型；当前静态目录只有 chat。 */
  readonly api: 'chat' | 'messages'
}

/** 一个账号的对话通道。`fetch` 收的是发往 WorkBuddy 的请求，返回上游流。 */
export interface WorkBuddySession {
  /** `request.signal` 会一路传到上游：调用方取消时，上游那条流也停。 */
  fetch(request: Request): Promise<Response>
  usage(): Promise<WorkBuddyUsage>
  checkin(): Promise<WorkBuddyCheckin>
  /** 校验 API Key 是否被 WorkBuddy 接受；没有可校验的路径时直接通过。 */
  validate(): Promise<void>
}

export interface WorkBuddySignIn {
  readonly url: string
  readonly instructions: string
  /** 等浏览器授权完成；失败抛 WorkBuddyClientError。 */
  callback(): Promise<WorkBuddyCredentials>
}

export interface WorkBuddySessionHooks {
  /** 插件刷新 token 后回调；宿主负责落盘。 */
  onUpdate(credentials: WorkBuddyCredentials): Promise<void> | void
}
