import { randomUUID } from 'node:crypto'
import type { CustomProviderDef, ModelsPort } from '@poietica/engine'
import { AppError, type Logger } from '@poietica/foundation'
import {
  type WorkBuddyCheckin as ClientCheckin,
  type WorkBuddyUsage as ClientUsage,
  createSession,
  listModels,
  randomProxySecret,
  startBrowserSignIn,
  startWorkBuddyProxy,
  WorkBuddyClientError,
  type WorkBuddyCredentials,
  type WorkBuddyModel,
  type WorkBuddyProxy,
  type WorkBuddyProxyAccounts,
  type WorkBuddyProxyOptions,
  type WorkBuddySession,
} from '@poietica/workbuddy-client'
import {
  type WorkBuddyAccount,
  type WorkBuddyCheckin,
  type WorkBuddyLoginEvent,
  type WorkBuddyProxy as WorkBuddyProxyView,
  type WorkBuddySnapshot,
  type WorkBuddyUsage,
  WorkBuddyUsage as WorkBuddyUsageSchema,
  type WorkBuddyUsageWindow,
} from '../contract'
import { workbuddyErrors } from '../contract/errors'
import type { AccountAuthPatch, AccountCheckinRecord, AccountRecord, WorkBuddyRepository } from './repository'

/* 客户端只导出入口函数的选项类型，失败回调的载荷从它身上取，避免在这儿重新写一份形状 */
type AccountFailure = Parameters<NonNullable<WorkBuddyProxyOptions['onAccountFailure']>>[1]

export const PROVIDER_ID = 'workbuddy'
const PROVIDER_NAME = 'WorkBuddy'
const SETTING_ENABLED = 'proxy_enabled'
const SETTING_AUTO_CHECKIN = 'auto_checkin'
const SETTING_PREFERRED = 'preferred_account_id'
const SETTING_PROVIDER = 'provider_registered'
const CHECKIN_INTERVAL_MS = 5 * 60 * 1000
const CHECKIN_RETRY_MS = 30 * 60 * 1000
const CHECKIN_SURE_HOUR = 12
const MINUTE_MS = 60 * 1000
const REST_RESTRICTED_MS = 2 * 60 * MINUTE_MS
const REST_EXHAUSTED_MS = 30 * MINUTE_MS
const REST_RATE_LIMIT_MS = MINUTE_MS
const REST_RATE_LIMIT_MAX_MS = 30 * MINUTE_MS
/* 上游没归类的失败（5xx / 超时）：换号重试，这个号自己歇一小会儿，连着出问题才往上翻 */
const REST_UNKNOWN_MS = MINUTE_MS
const REST_UNKNOWN_MAX_MS = 10 * MINUTE_MS
/*
 * 连续失败的「遗忘窗」：上一次休息结束这么久之后才算断了一轮，下一次从 1 分钟重新起
 * （magpie 的 rateForget）。没有它，一周里偶发几次限流会一路翻倍到 30 分钟并停在那儿。
 */
const REST_FORGET_MS = 30 * MINUTE_MS
/* 全都在休息时，最快回来的那个号多久放行一次去探路（magpie 的 probeOne 每次请求一次，我们更省） */
const REST_PROBE_MS = MINUTE_MS
/* 用到 90% / 98% 的账号排到后面：先撞它只会先吃一次额度用尽（magpie 的 fine / low / spent 三档） */
const USED_LOW_PERCENT = 90
const USED_SPENT_PERCENT = 98

export interface WorkBuddyServiceDeps {
  readonly repository: WorkBuddyRepository
  readonly models: ModelsPort
  readonly logger: Logger
  readonly now: () => number
  readonly emitChanged: () => void
  readonly emitLogin: (event: WorkBuddyLoginEvent) => void
  readonly startProxy?: typeof startWorkBuddyProxy
  readonly openSession?: typeof createSession
}

export interface WorkBuddyService {
  start(): Promise<void>
  dispose(): void
  snapshot(): WorkBuddySnapshot
  startBrowserLogin(accountId: string | null): Promise<{ loginId: string; url: string; instructions: string }>
  cancelLogin(loginId: string): void
  removeAccount(accountId: string): Promise<void>
  setPreferred(accountId: string): void
  refreshUsage(accountId: string | null): Promise<WorkBuddySnapshot>
  checkin(accountId: string): Promise<WorkBuddyCheckin>
  setEnabled(enabled: boolean): Promise<WorkBuddySnapshot>
  setAutoCheckin(enabled: boolean): Promise<WorkBuddySnapshot>
  repairProvider(): Promise<WorkBuddySnapshot>
}

interface LoginAttempt {
  readonly accountId: string | null
  cancelled: boolean
}

/** 签到按北京日算（WorkBuddy 的签到事件就按 UTC+8 换日），与本机时区无关。 */
const BEIJING_OFFSET_MS = 8 * 60 * MINUTE_MS

function localDay(at: number): string {
  const date = new Date(at + BEIJING_OFFSET_MS)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

function beijingHour(at: number): number {
  return new Date(at + BEIJING_OFFSET_MS).getUTCHours()
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function appErrorOf(cause: unknown, fallback: { code: string; message: string }): AppError {
  if (!(cause instanceof WorkBuddyClientError)) {
    return new AppError(fallback.code, fallback.message)
  }
  const codes: Record<string, string> = {
    not_signed_in: workbuddyErrors.not_signed_in,
    login_failed: workbuddyErrors.login_failed,
    usage_failed: workbuddyErrors.usage_failed,
    checkin_failed: workbuddyErrors.checkin_failed,
  }
  return new AppError(codes[cause.code] ?? fallback.code, cause.message)
}

function authPatchOf(credentials: WorkBuddyCredentials): AccountAuthPatch {
  return {
    authType: credentials.type,
    access: credentials.access,
    refresh: credentials.refresh,
    expires: credentials.expires,
    refreshExpiresAt: credentials.refreshExpiresAt,
    uid: credentials.uid,
    domain: credentials.domain,
    tokenType: credentials.tokenType,
    enterpriseId: credentials.enterpriseId,
    apiKey: credentials.type === 'api' ? credentials.key : '',
  }
}

function credentialsOf(record: AccountRecord): WorkBuddyCredentials {
  return {
    type: record.authType,
    access: record.access,
    refresh: record.refresh,
    expires: record.expires,
    refreshExpiresAt: record.refreshExpiresAt,
    uid: record.uid,
    accountId: record.label,
    domain: record.domain,
    tokenType: record.tokenType,
    enterpriseId: record.enterpriseId,
    key: record.apiKey,
  }
}

/*
 * 库里的 usage_json 是上一个版本写下的：契约后来给窗口加了 aside / runsOut / notModels，
 * 老记录里没有这三格。直接 safeParse 会把整段判成不合法、返回 null，用户升级后设置页就
 * 一直显示「积分尚未读取」，直到下次刷新。这里先补默认值再校验 —— 缺的格子按「上游没说」处理，
 * 界面与反代照旧按必填写。
 */
function withWindowDefaults(usage: unknown): unknown {
  if (typeof usage !== 'object' || usage === null) return usage
  const windows = (usage as { windows?: unknown }).windows
  if (!Array.isArray(windows)) return usage
  return {
    ...usage,
    windows: windows.map((window) => {
      if (typeof window !== 'object' || window === null) return window
      return { aside: false, runsOut: null, notModels: null, ...window }
    }),
  }
}

function parseUsage(record: AccountRecord): WorkBuddyUsage | null {
  if (record.usageJson === null) return null
  try {
    const parsed = WorkBuddyUsageSchema.safeParse(withWindowDefaults(JSON.parse(record.usageJson)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function usageIsExpired(usage: ClientUsage): boolean {
  if (usage.signIn === 'expired') return true
  return usage.error !== null && /401|unauthor|sign.?in|重新登录|登录/i.test(usage.error)
}

function checkinViewOf(record: AccountCheckinRecord): WorkBuddyCheckin {
  return {
    at: record.at,
    day: record.day,
    outcome: record.outcome as WorkBuddyCheckin['outcome'],
    credit: record.credit,
    streak: record.streak,
    message: record.message,
  }
}

/**
 * 签到的重试时刻。failed 一律 30 分钟后再问；ineligible / inactive 只在当天 12 点前才排重试 ——
 * 12 点前拿到的「不参与 / 没活动」可能是上游还没换日给的答案（magpie 的 #3326），过了中午才是它今天的结论。
 * done / claimed 是这天已经签成了，当天不再问。
 */
function checkinNextTryAt(outcome: string, at: number): number {
  if (outcome === 'failed') return at + CHECKIN_RETRY_MS
  if (outcome === 'ineligible' || outcome === 'inactive') {
    return beijingHour(at) < CHECKIN_SURE_HOUR ? at + CHECKIN_RETRY_MS : 0
  }
  return 0
}

/** 这天的签到还值不值得再问一次：换了日就问；签成了不问；其余等退避到点。 */
function checkinDue(record: AccountRecord, day: string, at: number): boolean {
  const checkin = record.checkin
  if (checkin === null || checkin.day !== day) return true
  if (checkin.outcome === 'done' || checkin.outcome === 'claimed') return false
  return at >= checkin.nextTryAt
}

function checkinIneligibleRecord(at: number): AccountCheckinRecord {
  return {
    day: localDay(at),
    at,
    outcome: 'ineligible',
    message: 'API Key 账号不参与签到',
    credit: null,
    streak: null,
    nextTryAt: 0,
  }
}

export function createWorkBuddyService(deps: WorkBuddyServiceDeps): WorkBuddyService {
  const { repository, models, logger, now, emitChanged, emitLogin } = deps
  const startProxy = deps.startProxy ?? startWorkBuddyProxy
  const openSession = deps.openSession ?? createSession
  const saved = repository.settings()
  let enabled = saved[SETTING_ENABLED] !== '0'
  let autoCheckin = saved[SETTING_AUTO_CHECKIN] !== '0'
  let preferredId =
    saved[SETTING_PREFERRED] === undefined || saved[SETTING_PREFERRED] === '' ? null : saved[SETTING_PREFERRED]
  let providerRegistered = saved[SETTING_PROVIDER] === '1'
  let proxy: WorkBuddyProxy | null = null
  let providerState: WorkBuddyProxyView['providerState'] = enabled
    ? providerRegistered
      ? 'registered'
      : 'missing'
    : 'disabled'
  let providerMessage: string | null = null
  let modelsCache: readonly WorkBuddyModel[] | null = null
  let syncPromise: Promise<void> | null = null
  let started = false
  let timer: ReturnType<typeof setInterval> | null = null
  const sessions = new Map<string, Promise<WorkBuddySession>>()
  const logins = new Map<string, LoginAttempt>()

  const changed = (): void => {
    emitChanged()
  }

  /*
   * 连续失败计数：同一个账号连着失败就翻倍等待（1 → 2 → 4 …）。两种阶梯各自计数 ——
   * 限流封顶 30 分钟（magpie 的 rateRest）、未归类失败封顶 10 分钟（magpie 的 failOther）——
   * 并由 lastFailureAt 做遗忘：上一次休息结束 30 分钟后才再失败，算新的一轮，从 1 分钟重新起。
   * 一次成功应答即清零（magpie 的 served）：偶发的一次不该让这个号一路翻倍到半小时。
   */
  interface Strikes {
    n: number
    until: number
  }
  const rateLimitStrikes = new Map<string, Strikes>()
  const unknownStrikes = new Map<string, Strikes>()
  /* 休息中的号上一次被当探针放行是什么时候：全都在歇时每分钟探一次就够，不必每个请求都去撞 */
  const probeAt = new Map<string, number>()

  const strikeRestMs = (
    strikes: Map<string, Strikes>,
    accountId: string,
    at: number,
    base: number,
    max: number,
  ): number => {
    const prev = strikes.get(accountId)
    /* 上一轮已经过去够久（或休息早已结束并又安宁了一阵）：从最小档重新起 */
    const fresh = prev === undefined || at - prev.until > REST_FORGET_MS
    const n = fresh ? 0 : prev.n
    const ms = Math.min(max, base * 2 ** n)
    strikes.set(accountId, { n: n + 1, until: at + ms })
    return ms
  }

  const rateLimitRestMs = (accountId: string, at: number): number =>
    strikeRestMs(rateLimitStrikes, accountId, at, REST_RATE_LIMIT_MS, REST_RATE_LIMIT_MAX_MS)

  const unknownRestMs = (accountId: string, at: number): number =>
    strikeRestMs(unknownStrikes, accountId, at, REST_UNKNOWN_MS, REST_UNKNOWN_MAX_MS)

  /** 答出来一次：这个号刚证明自己是好的，两条阶梯一起清零。 */
  const noteAnswered = (accountId: string): void => {
    rateLimitStrikes.delete(accountId)
    unknownStrikes.delete(accountId)
  }

  /**
   * 一个账号这一轮该排第几，照 magpie 的 Smart（internal/routes/strategies.go）：
   * 先看用量分档（快用完的排后面），再看谁的积分先到期 —— 到期那一批是先花掉还是作废的分界，
   * 与界面那行「N 积分即将到期」是同一个数；都看不出来时保持原序（保住上游的提示缓存）。
   *
   * 没读过的账号（usage 为 null）当「还很有余量、积分不会先到期」。aside 那格只是摆着看，不计。
   */
  const tierOf = (used: number): number => {
    if (used >= USED_SPENT_PERCENT) return 2
    return used >= USED_LOW_PERCENT ? 1 : 0
  }

  /** 一格积分窗口的「已用比例」与「什么时候作废」；读不出比例按 0 算。 */
  const shareOf = (window: WorkBuddyUsageWindow): { used: number; lapse: number } => {
    const amount = window.used
    const limit = window.limit
    const sized = amount !== null && limit !== null && limit > 0
    const at = window.runsOutAt === null ? Number.NaN : Date.parse(window.runsOutAt)
    return { used: sized ? amount : 0, lapse: Number.isFinite(at) ? at : Number.POSITIVE_INFINITY }
  }

  const rankOf = (record: AccountRecord): { tier: number; lapse: number; used: number } => {
    const windows = parseUsage(record)?.windows.filter((window) => !window.aside) ?? []
    const ranks = windows.map(shareOf)
    const used = Math.max(0, ...ranks.map((rank) => rank.used))
    const lapse = Math.min(Number.POSITIVE_INFINITY, ...ranks.map((rank) => rank.lapse))
    return { tier: tierOf(used), lapse, used }
  }

  /** 排序键：[用量分档, 积分到期时刻, 已用比例, 首选?, 创建时间]。 */
  const compareRecords = (a: AccountRecord, b: AccountRecord): number => {
    const ra = rankOf(a)
    const rb = rankOf(b)
    if (ra.tier !== rb.tier) return ra.tier - rb.tier
    if (ra.lapse !== rb.lapse) return ra.lapse - rb.lapse
    if (ra.used !== rb.used) return ra.used - rb.used
    /* 首选只在同分时表态：它压不过「谁的额度先到期」 */
    const pa = a.id === preferredId ? 0 : 1
    const pb = b.id === preferredId ? 0 : 1
    if (pa !== pb) return pa - pb
    return a.createdAt - b.createdAt
  }

  /**
   * 选号顺序，照 magpie 的 Smart 再叠一层「别把休息中的号丢掉」：
   * 1. 可用的号按 [用量分档, 积分到期时刻, 已用比例, 首选?, 创建时间] 稳定排序；
   * 2. 失效的、休息中的排在后面 —— 不是删掉。「全都歇着」与「一个号都没有」是两件事，
   *    前者由反代回 429 + Retry-After，后者才回 401；
   * 3. 休息中的号按「谁先回来」排，交给 proxyAccounts 决定放哪一个去探路
   *    （magpie 的 probeOne）：一个号被误判成受限时仍能验证它回来了，
   *    而不是让用户在半小时里看着「没登录」。
   */
  const orderedRecords = (at: number): readonly AccountRecord[] => {
    const records = repository.list()
    const usable = records.filter((record) => record.restUntil <= at)
    const inactive = records.filter((record) => record.restUntil > at).sort((a, b) => a.restUntil - b.restUntil)
    const active = usable.filter((record) => record.status !== 'expired')
    const expired = usable.filter((record) => record.status === 'expired')
    const ranked = [...active].sort((a, b) => compareRecords(a, b))
    return [...ranked, ...expired, ...inactive]
  }

  async function sessionFor(record: AccountRecord): Promise<WorkBuddySession> {
    const cached = sessions.get(record.id)
    if (cached !== undefined) return await cached
    const created = openSession(credentialsOf(record), {
      async onUpdate(credentials) {
        repository.updateAuth(record.id, authPatchOf(credentials), now())
        repository.setStatus(record.id, 'ok', null, now())
        /* 插件把令牌换新了，这个号刚证明自己是好的 */
        noteAnswered(record.id)
      },
    })
    sessions.set(record.id, created)
    created.catch(() => {
      sessions.delete(record.id)
    })
    return await created
  }

  /**
   * 交给反代的名单。可用的号按排序给；一个可用的都没有时，最多放一个「最快回来的」当探针 ——
   * 上游刚说它受限 / 没额度 / 被限流，但那个判断可能是错的，每分钟探一次能让它自己回来，
   * 而不是让用户在半小时里看着「还没有登录」。探针之外的情形回 429 + Retry-After（反代负责），
   * 只有一个号都没有时才是 401（magpie 的 restLast + probeOne + quotaHeld 是同一套分层）。
   */
  async function proxyAccounts(): Promise<WorkBuddyProxyAccounts> {
    const at = now()
    const records = orderedRecords(at)
    const usable = records.filter((record) => record.restUntil <= at)
    const resting = records.filter((record) => record.restUntil > at)
    const handed: { id: string; session: WorkBuddySession }[] = []
    for (const record of usable) {
      try {
        handed.push({ id: record.id, session: await sessionFor(record) })
      } catch (cause) {
        logger.warn('WorkBuddy 账号通道建立失败', { account: record.id, error: messageOf(cause) })
      }
    }
    if (handed.length > 0) return { accounts: handed }
    if (resting.length === 0) return { accounts: [] }
    const soonest = resting[0] as AccountRecord
    const lastProbe = probeAt.get(soonest.id) ?? 0
    if (at - lastProbe < REST_PROBE_MS) return { accounts: [], restingUntil: soonest.restUntil }
    try {
      const session = await sessionFor(soonest)
      probeAt.set(soonest.id, at)
      return { accounts: [{ id: soonest.id, session }] }
    } catch (cause) {
      logger.warn('WorkBuddy 账号通道建立失败', { account: soonest.id, error: messageOf(cause) })
      return { accounts: [], restingUntil: soonest.restUntil }
    }
  }

  const chatModels = (): readonly WorkBuddyModel[] => (modelsCache ?? []).filter((model) => model.api === 'chat')

  function providerDef(): CustomProviderDef {
    return {
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      api: 'openai-completions',
      baseUrl: proxy?.baseUrl ?? '',
      /*
       * 让 omp 在每个请求上带 x-conversation-id：反代把它转成插件的内部会话头，
       * 插件据此算 X-Conversation-ID（会话身份不再靠「第一条用户消息的摘要 + 每进程随机盐」，
       * Core 重启后同一会话仍是同一会话）。omp 只在有会话 id 时才发这个头。
       */
      sessionHeader: 'x-conversation-id',
      models: chatModels().map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        reasoning: model.reasoning,
        vision: model.vision,
      })),
    }
  }

  /**
   * 把反代的地址写回模型目录。反代每次启动都换新端口与新口令，不写回去 omp 会一直打上一次
   * 那个已经死掉的端口，而界面还报 running —— 所以拿到目录就已经在那儿的时候也必须写。
   */
  async function writeProvider(claim: boolean): Promise<void> {
    await models.upsertCustomProvider(providerDef())
    if (claim && !providerRegistered) {
      providerRegistered = true
      repository.setSetting(SETTING_PROVIDER, '1')
    }
  }

  function markRegistered(): void {
    providerState = 'registered'
    providerMessage = null
  }

  /** 目录里那条是不是我们自己注册的：id 对上了，还得是自定义且名字没被改过。 */
  function isOwnProvider(provider: { custom: boolean; name: string }): boolean {
    return provider.custom && provider.name === PROVIDER_NAME
  }

  async function ensureProvider(): Promise<void> {
    if (modelsCache === null) modelsCache = await listModels()
    if (chatModels().length === 0) throw new AppError(workbuddyErrors.proxy_failed, 'WorkBuddy 没有可用模型')
    const existing = (await models.providers()).find((provider) => provider.id === PROVIDER_ID)
    /* 没有、或者是自己那一份（provider_registered 丢掉时的收养）：写回并认领 */
    if (existing === undefined || isOwnProvider(existing)) {
      await writeProvider(true)
      markRegistered()
      return
    }
    providerState = 'conflict'
    providerMessage = existing.custom
      ? '模型服务商 workbuddy 已存在；请先在「模型」里移除它，再点重新注册'
      : 'workbuddy 是内置服务商，不能覆盖'
    /*
     * 名字被改过、或上一版留下的旧条目会走到这里。反代已经换了端口与口令，而模型目录里那条
     * 我们仍认作自己的（provider_registered=1）就只写地址不认领 —— 界面照旧报冲突等人决定，
     * 但 omp 不会打到一个死端口上。
     */
    if (!providerRegistered) return
    await writeProvider(false).catch((cause: unknown) => {
      logger.warn('WorkBuddy 反代地址没能写回模型目录', { error: messageOf(cause) })
    })
  }

  /** 401 的落账：只有插件说登录真没了（expired / 没说）才标失效，kept 只是这次被拒。 */
  function noteSignInFailure(accountId: string, failure: AccountFailure): void {
    const at = now()
    if (failure.signIn === 'kept') {
      /* 插件明说账号没坏：只记一条，别把用户的号标成要重新登录 */
      logger.warn('WorkBuddy 拒绝了这次请求，但账号仍有效', { account: accountId, status: failure.status })
      return
    }
    if (failure.signIn === 'renewed') {
      repository.setStatus(accountId, 'ok', null, at)
      repository.clearRest(accountId, at)
      noteAnswered(accountId)
      return
    }
    /* expired，或上游没说语义（保守当失效）*/
    repository.setStatus(accountId, 'expired', 'WorkBuddy 拒绝了这次登录，请重新登录', at)
    repository.clearRest(accountId, at)
    sessions.delete(accountId)
  }

  /**
   * 一次失败该让账号歇多久；null = 不歇（只有登录真的没了才不歇，那时换个号也没用）。
   * 上游自己写了恢复时刻（WorkBuddy 的限流窗口会写「将在 … 重置」）就以它为准：
   * 按固定时长猜只会到期再撞一次，把一次窗口已满拖成反复冲撞。
   */
  function restMsOf(accountId: string, failure: AccountFailure): number | null {
    const at = now()
    /* 上游写了恢复时刻就用它，至少给到该类的固定时长 */
    const named = failure.resetAt === undefined ? null : Math.max(MINUTE_MS, failure.resetAt - at)
    const atLeast = (base: number): number => (named === null ? base : Math.max(base, named))
    if (failure.kind === 'sign_in') return null
    if (failure.kind === 'restricted') return atLeast(REST_RESTRICTED_MS)
    if (failure.kind === 'exhausted') return atLeast(REST_EXHAUSTED_MS)
    if (failure.kind === 'unknown') return unknownRestMs(accountId, at)
    if (named !== null) return named
    return rateLimitRestMs(accountId, at)
  }

  const restReasonOf: Record<AccountFailure['kind'], string> = {
    sign_in: '需要重新登录',
    restricted: 'WorkBuddy 说这个账号存在异常行为，先歇一会儿',
    exhausted: '这个账号的积分用完了，等回血',
    rate_limit: '请求太密，先缓一缓',
    unknown: '上游这次没答上来，先跳过它',
  }

  function noteAccountFailure(accountId: string, failure: AccountFailure): void {
    const record = repository.get(accountId)
    if (record === null) return
    if (failure.kind === 'sign_in') {
      noteSignInFailure(accountId, failure)
    } else {
      const restMs = restMsOf(accountId, failure)
      const at = now()
      if (restMs !== null) {
        /*
         * 只延长不缩短：一次一小时的受限休息不该被紧接着的一条 429 改成 1 分钟
         * （magpie #3289 的同一个判断）。已经在歇、而且歇得更久，就保持原样。
         */
        const until = Math.max(at + restMs, record.restUntil)
        repository.setRest(accountId, until, restReasonOf[failure.kind] ?? '暂时不要用这个账号', at)
        /* 刚失败过就先别探：等一个探路间隔，免得一次误判变成每个请求都去撞一次上游 */
        probeAt.set(accountId, at)
        logger.warn('WorkBuddy 账号进入休息', {
          account: accountId,
          kind: failure.kind,
          status: failure.status,
          restMs: until - at,
        })
      }
    }
    changed()
  }

  async function startServer(): Promise<void> {
    if (proxy !== null) return
    const server = startProxy({
      secret: randomProxySecret(),
      accounts: proxyAccounts,
      models: chatModels,
      onAccountFailure: noteAccountFailure,
      /* 任何一次成功应答都说明这个号是好的：连续失败计数清零、休息解除（magpie 的 served） */
      onAccountAnswered: (accountId) => {
        const at = now()
        noteAnswered(accountId)
        probeAt.delete(accountId)
        const record = repository.get(accountId)
        if (record !== null && record.restUntil > at) {
          repository.clearRest(accountId, at)
          changed()
        }
      },
      /* 插件刷新出了新令牌并顺手成功了：这个号刚证明自己是好的，之前的限流计数与休息就该清掉 */
      onAccountRenewed: (accountId) => {
        const at = now()
        noteAnswered(accountId)
        repository.clearRest(accountId, at)
        repository.setStatus(accountId, 'ok', null, at)
        changed()
      },
      log: (message, data) => logger.warn(message, data),
    })
    proxy = server
  }

  async function stopServer(removeProvider = true): Promise<void> {
    proxy?.stop()
    proxy = null
    if (!removeProvider || !providerRegistered) return
    try {
      await models.removeCustomProvider(PROVIDER_ID)
      providerRegistered = false
      repository.setSetting(SETTING_PROVIDER, '0')
    } catch (cause) {
      logger.warn('移除 WorkBuddy 模型服务商失败', { error: messageOf(cause) })
    }
  }

  async function syncProxyOnce(): Promise<void> {
    if (!enabled) {
      await stopServer()
      providerState = 'disabled'
      providerMessage = null
      return
    }
    if (repository.list().length === 0) {
      await stopServer()
      providerState = 'missing'
      providerMessage = '先登录一个 WorkBuddy 账号'
      return
    }
    try {
      if (modelsCache === null) modelsCache = await listModels()
      await startServer()
      await ensureProvider()
    } catch (cause) {
      providerState = 'error'
      providerMessage = messageOf(cause)
      logger.warn('WorkBuddy 反代注册失败', { error: providerMessage })
    }
  }

  function syncProxy(): Promise<void> {
    if (syncPromise !== null) return syncPromise
    const running = syncProxyOnce().finally(() => {
      if (syncPromise === running) syncPromise = null
    })
    syncPromise = running
    return running
  }

  function proxyView(): WorkBuddyProxyView {
    return {
      enabled,
      running: proxy !== null,
      port: proxy?.port ?? null,
      endpoint: proxy === null ? null : `http://127.0.0.1:${String(proxy.port)}/p/••••/v1`,
      providerId: PROVIDER_ID,
      providerState,
      providerMessage,
    }
  }

  function accountView(record: AccountRecord, preferred: string | null): WorkBuddyAccount {
    const usage = parseUsage(record)
    const checkin = record.checkin === null ? null : checkinViewOf(record.checkin)
    const checkedInToday =
      checkin !== null &&
      checkin.day === localDay(now()) &&
      (checkin.outcome === 'claimed' || checkin.outcome === 'done')
    return {
      id: record.id,
      label: record.label,
      uid: record.uid,
      kind: record.authType === 'api' ? 'api_key' : 'browser',
      plan: record.plan === '' ? null : record.plan,
      preferred: preferred === record.id,
      status: record.status,
      statusMessage: record.statusMessage,
      usage,
      usageAt: record.usageAt,
      checkedInToday,
      checkin,
      createdAt: record.createdAt,
      restUntil: record.restUntil,
      restReason: record.restUntil > now() ? record.restReason : null,
    }
  }

  function snapshot(): WorkBuddySnapshot {
    const records = orderedRecords(now())
    /*
     * 首选只认用户设过的那一个：它失效了就显示「没有首选」，而不是让徽标悄悄飘到别的号上
     * （飘过去之后用户以为自己选的还是原来那个）。
     */
    const preferred =
      preferredId !== null && records.some((record) => record.id === preferredId && record.status !== 'expired')
        ? preferredId
        : null
    return {
      accounts: records.map((record) => accountView(record, preferred)),
      proxy: proxyView(),
      autoCheckin,
    }
  }

  function rememberPreferred(accountId: string): void {
    if (preferredId !== null && repository.get(preferredId) !== null) return
    preferredId = accountId
    repository.setSetting(SETTING_PREFERRED, accountId)
  }

  function upsertAccount(credentials: WorkBuddyCredentials, accountId: string | null): string {
    const at = now()
    const label =
      credentials.accountId !== '' ? credentials.accountId : credentials.uid !== '' ? credentials.uid : 'WorkBuddy'
    const existing =
      accountId === null
        ? credentials.uid === ''
          ? null
          : repository.findByIdentity(credentials.uid, label)
        : repository.get(accountId)
    if (existing !== null) {
      repository.updateAuth(existing.id, authPatchOf(credentials), at)
      repository.updateIdentity(existing.id, label, credentials.uid, existing.plan, at)
      repository.setStatus(existing.id, 'ok', null, at)
      /* 人刚重新登录过：凭据换了，之前那条休息与限流计数就不该再拦着它 */
      repository.clearRest(existing.id, at)
      noteAnswered(existing.id)
      sessions.delete(existing.id)
      rememberPreferred(existing.id)
      return existing.id
    }
    const id = randomUUID()
    repository.insert({
      id,
      label,
      authType: credentials.type,
      access: credentials.access,
      refresh: credentials.refresh,
      expires: credentials.expires,
      refreshExpiresAt: credentials.refreshExpiresAt,
      uid: credentials.uid,
      domain: credentials.domain,
      tokenType: credentials.tokenType,
      enterpriseId: credentials.enterpriseId,
      apiKey: credentials.type === 'api' ? credentials.key : '',
      plan: '',
      status: 'ok',
      statusMessage: null,
      usageJson: null,
      usageAt: null,
      restUntil: 0,
      restReason: null,
      checkin: null,
      createdAt: at,
      updatedAt: at,
    })
    rememberPreferred(id)
    return id
  }

  function finishLogin(loginId: string, attempt: LoginAttempt, credentials: WorkBuddyCredentials): void {
    if (attempt.cancelled) {
      logins.delete(loginId)
      return
    }
    const accountId = upsertAccount(credentials, attempt.accountId)
    logins.delete(loginId)
    emitLogin({ loginId, state: 'done', accountId, message: null })
    changed()
    void refreshUsage(accountId).catch((cause) => logger.warn('登录后读取积分失败', { error: messageOf(cause) }))
    void syncProxy().catch((cause) => logger.warn('登录后启动 WorkBuddy 反代失败', { error: messageOf(cause) }))
  }

  async function runBrowserCallback(
    loginId: string,
    attempt: LoginAttempt,
    callback: () => Promise<WorkBuddyCredentials>,
  ): Promise<void> {
    try {
      finishLogin(loginId, attempt, await callback())
    } catch (cause) {
      logins.delete(loginId)
      if (attempt.cancelled) return
      emitLogin({ loginId, state: 'failed', accountId: null, message: messageOf(cause) })
      logger.warn('WorkBuddy 浏览器登录失败', { error: messageOf(cause) })
    }
  }

  async function checkinRecord(record: AccountRecord, manual: boolean): Promise<WorkBuddyCheckin> {
    const at = now()
    if (record.authType === 'api') {
      const unclaimed = checkinIneligibleRecord(at)
      repository.updateCheckin(record.id, unclaimed, at)
      changed()
      return checkinViewOf(unclaimed)
    }
    try {
      const session = await sessionFor(record)
      const result: ClientCheckin = await session.checkin()
      const checkin: AccountCheckinRecord = {
        day: localDay(at),
        at,
        outcome: result.outcome,
        message: result.message,
        credit: result.credit,
        streak: result.streak,
        nextTryAt: checkinNextTryAt(result.outcome, at),
      }
      repository.updateCheckin(record.id, checkin, at)
      if (result.outcome === 'claimed' || result.outcome === 'done') {
        repository.setStatus(record.id, 'ok', null, at)
        void refreshUsage(record.id).catch((cause) => logger.warn('签到后刷新积分失败', { error: messageOf(cause) }))
      }
      changed()
      return checkinViewOf(checkin)
    } catch (cause) {
      noteCheckinFailure(record.id, cause, at, manual)
      throw manual ? appErrorOf(cause, { code: workbuddyErrors.checkin_failed, message: 'WorkBuddy 签到失败' }) : cause
    }
  }

  /**
   * 没问出结果也算一次落账：不写的话，下一次定时器分不出「今天没试过」和「刚试过、没答上来」，
   * 5 分钟一拍就会变成对上游的连打。手动按的那次不记，让用户再按还能立刻重试。
   */
  function noteCheckinFailure(accountId: string, cause: unknown, at: number, manual: boolean): void {
    logger.warn(manual ? 'WorkBuddy 签到失败' : '自动签到失败', { account: accountId, error: messageOf(cause) })
    if (manual) return
    repository.updateCheckin(
      accountId,
      {
        day: localDay(at),
        at,
        outcome: 'failed',
        message: messageOf(cause),
        credit: null,
        streak: null,
        nextTryAt: at + CHECKIN_RETRY_MS,
      },
      at,
    )
    changed()
  }

  async function autoCheckinAll(): Promise<void> {
    if (!autoCheckin) return
    const at = now()
    const day = localDay(at)
    for (const record of repository.list()) {
      if (record.authType !== 'oauth' || !checkinDue(record, day, at)) continue
      try {
        await checkinRecord(record, false)
      } catch {
        /* checkinRecord 已记日志并写了退避；等下一次定时器或用户手动重试 */
      }
    }
  }

  /**
   * 读一个号的积分，并按读数修正它的状态：登录没了标 expired；读数说已经回血
   * （充值、换日、新套餐）就松开之前那条休息 —— 不必让用户干等到点。
   */
  async function refreshAccountUsage(record: AccountRecord): Promise<void> {
    try {
      const at = now()
      const usage = await (await sessionFor(record)).usage()
      repository.updateUsage(record.id, usage.plan ?? record.plan, JSON.stringify(usage), at, at)
      if (usageIsExpired(usage)) {
        repository.setStatus(record.id, 'expired', usage.error ?? 'WorkBuddy 登录已过期', at)
        return
      }
      if (usage.error !== null) return
      repository.setStatus(record.id, 'ok', null, at)
      const blocked = usage.windows.some((window) => window.refused)
      if (blocked || record.restUntil <= at) return
      repository.clearRest(record.id, at)
      probeAt.delete(record.id)
    } catch (cause) {
      logger.warn('读取 WorkBuddy 积分失败', { account: record.id, error: messageOf(cause) })
      repository.setStatus(record.id, 'error', messageOf(cause), now())
    }
  }

  async function refreshUsage(accountId: string | null): Promise<WorkBuddySnapshot> {
    const records =
      accountId === null
        ? repository.list()
        : [repository.get(accountId)].filter((record): record is AccountRecord => record !== null)
    if (accountId !== null && records.length === 0) {
      throw new AppError(workbuddyErrors.account_not_found, 'WorkBuddy 账号不存在')
    }
    await Promise.all(records.map(async (record) => await refreshAccountUsage(record)))
    changed()
    return snapshot()
  }

  return {
    async start() {
      if (started) return
      started = true
      await syncProxy().catch((cause) => logger.warn('WorkBuddy 反代启动失败', { error: messageOf(cause) }))
      void autoCheckinAll().catch((cause) => logger.warn('WorkBuddy 自动签到失败', { error: messageOf(cause) }))
      timer = setInterval(() => {
        void autoCheckinAll().catch((cause) => logger.warn('WorkBuddy 定时签到失败', { error: messageOf(cause) }))
      }, CHECKIN_INTERVAL_MS)
    },
    dispose() {
      if (timer !== null) clearInterval(timer)
      timer = null
      /* Core 会重启：这些表挂在进程上，不显式清掉就是只增不减（登录尝试还会等一个永远不来的回调） */
      logins.clear()
      sessions.clear()
      rateLimitStrikes.clear()
      unknownStrikes.clear()
      void stopServer(false).catch((cause) => logger.warn('关闭 WorkBuddy 反代失败', { error: messageOf(cause) }))
    },
    snapshot,
    async startBrowserLogin(accountId) {
      if (accountId !== null && repository.get(accountId) === null) {
        throw new AppError(workbuddyErrors.account_not_found, 'WorkBuddy 账号不存在')
      }
      const signIn = await startBrowserSignIn().catch((cause: unknown) => {
        throw appErrorOf(cause, { code: workbuddyErrors.login_failed, message: 'WorkBuddy 登录失败，请重试' })
      })
      const loginId = randomUUID()
      const attempt: LoginAttempt = { accountId, cancelled: false }
      logins.set(loginId, attempt)
      emitLogin({ loginId, state: 'waiting', accountId, message: signIn.instructions })
      void runBrowserCallback(loginId, attempt, signIn.callback)
      return { loginId, url: signIn.url, instructions: signIn.instructions }
    },
    cancelLogin(loginId) {
      const attempt = logins.get(loginId)
      if (attempt === undefined) return
      attempt.cancelled = true
      emitLogin({ loginId, state: 'failed', accountId: null, message: '登录已取消' })
      logins.delete(loginId)
    },
    async removeAccount(accountId) {
      if (repository.get(accountId) === null) {
        throw new AppError(workbuddyErrors.account_not_found, 'WorkBuddy 账号不存在')
      }
      repository.remove(accountId)
      sessions.delete(accountId)
      if (preferredId === accountId) {
        preferredId = repository.list()[0]?.id ?? null
        if (preferredId === null) repository.setSetting(SETTING_PREFERRED, '')
        else repository.setSetting(SETTING_PREFERRED, preferredId)
      }
      changed()
      await syncProxy()
    },
    setPreferred(accountId) {
      if (repository.get(accountId) === null) {
        throw new AppError(workbuddyErrors.account_not_found, 'WorkBuddy 账号不存在')
      }
      preferredId = accountId
      repository.setSetting(SETTING_PREFERRED, accountId)
      changed()
    },
    refreshUsage,
    async checkin(accountId) {
      const record = repository.get(accountId)
      if (record === null) throw new AppError(workbuddyErrors.account_not_found, 'WorkBuddy 账号不存在')
      return await checkinRecord(record, true)
    },
    async setEnabled(next) {
      enabled = next
      repository.setSetting(SETTING_ENABLED, next ? '1' : '0')
      await syncProxy()
      changed()
      return snapshot()
    },
    async setAutoCheckin(next) {
      autoCheckin = next
      repository.setSetting(SETTING_AUTO_CHECKIN, next ? '1' : '0')
      if (next) void autoCheckinAll().catch((cause) => logger.warn('自动签到失败', { error: messageOf(cause) }))
      changed()
      return snapshot()
    },
    async repairProvider() {
      await stopServer()
      providerState = 'missing'
      providerMessage = null
      await syncProxy()
      changed()
      return snapshot()
    },
  }
}
