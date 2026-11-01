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
} from '../contract'
import { workbuddyErrors } from '../contract/errors'
import type { AccountAuthPatch, AccountCheckinRecord, AccountRecord, WorkBuddyRepository } from './repository'

export const PROVIDER_ID = 'workbuddy'
const PROVIDER_NAME = 'WorkBuddy'
const SETTING_ENABLED = 'proxy_enabled'
const SETTING_AUTO_CHECKIN = 'auto_checkin'
const SETTING_PREFERRED = 'preferred_account_id'
const SETTING_PROVIDER = 'provider_registered'
const CHECKIN_INTERVAL_MS = 60 * 60 * 1000

export interface WorkBuddyServiceDeps {
  readonly repository: WorkBuddyRepository
  readonly models: ModelsPort
  readonly logger: Logger
  readonly now: () => number
  readonly openExternal: (url: string) => Promise<void>
  readonly emitChanged: () => void
  readonly emitLogin: (event: WorkBuddyLoginEvent) => void
}

export interface WorkBuddyService {
  start(): Promise<void>
  dispose(): void
  snapshot(): WorkBuddySnapshot
  startBrowserLogin(accountId: string | null): Promise<{ loginId: string; url: string; instructions: string }>
  cancelLogin(loginId: string): void
  addApiKey(apiKey: string): Promise<{ accountId: string }>
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

function localDay(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
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
    api_key_invalid: workbuddyErrors.api_key_invalid,
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

function parseUsage(record: AccountRecord): WorkBuddyUsage | null {
  if (record.usageJson === null) return null
  try {
    const parsed = WorkBuddyUsageSchema.safeParse(JSON.parse(record.usageJson))
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

export function createWorkBuddyService(deps: WorkBuddyServiceDeps): WorkBuddyService {
  const { repository, models, logger, now, openExternal, emitChanged, emitLogin } = deps
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

  const orderedRecords = (): readonly AccountRecord[] => {
    const records = repository.list()
    const active = records.filter((record) => record.status !== 'expired')
    const expired = records.filter((record) => record.status === 'expired')
    const preferred = preferredId === null ? undefined : active.find((record) => record.id === preferredId)
    if (preferred === undefined) return [...active, ...expired]
    return [preferred, ...active.filter((record) => record.id !== preferred.id), ...expired]
  }

  async function sessionFor(record: AccountRecord): Promise<WorkBuddySession> {
    const cached = sessions.get(record.id)
    if (cached !== undefined) return await cached
    const created = createSession(credentialsOf(record), {
      async onUpdate(credentials) {
        repository.updateAuth(record.id, authPatchOf(credentials), now())
        repository.setStatus(record.id, 'ok', null, now())
      },
    })
    sessions.set(record.id, created)
    created.catch(() => {
      sessions.delete(record.id)
    })
    return await created
  }

  async function proxyAccounts(): Promise<readonly { id: string; session: WorkBuddySession }[]> {
    const out: { id: string; session: WorkBuddySession }[] = []
    for (const record of orderedRecords()) {
      try {
        out.push({ id: record.id, session: await sessionFor(record) })
      } catch (cause) {
        logger.warn('WorkBuddy 账号通道建立失败', { account: record.id, error: messageOf(cause) })
      }
    }
    return out
  }

  const chatModels = (): readonly WorkBuddyModel[] => (modelsCache ?? []).filter((model) => model.api === 'chat')

  function providerDef(): CustomProviderDef {
    return {
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      api: 'openai-completions',
      baseUrl: proxy?.baseUrl ?? '',
      models: chatModels().map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        reasoning: model.reasoning,
        vision: model.vision,
      })),
    }
  }

  async function ensureProvider(): Promise<void> {
    if (modelsCache === null) modelsCache = await listModels()
    if (chatModels().length === 0) throw new AppError(workbuddyErrors.proxy_failed, 'WorkBuddy 没有可用模型')
    const providers = await models.providers()
    const existing = providers.find((provider) => provider.id === PROVIDER_ID)
    if (existing !== undefined && !providerRegistered) {
      if (existing.custom && existing.name === PROVIDER_NAME) {
        providerRegistered = true
        repository.setSetting(SETTING_PROVIDER, '1')
      } else {
        providerState = 'conflict'
        providerMessage = '模型服务商 workbuddy 已存在；请先在「模型」里移除它，再点重新注册'
        return
      }
    }
    if (existing !== undefined && !existing.custom) {
      providerState = 'conflict'
      providerMessage = 'workbuddy 是内置服务商，不能覆盖'
      return
    }
    await models.upsertCustomProvider(providerDef())
    if (!providerRegistered) {
      providerRegistered = true
      repository.setSetting(SETTING_PROVIDER, '1')
    }
    providerState = 'registered'
    providerMessage = null
  }

  async function startServer(): Promise<void> {
    if (proxy !== null) return
    const server = startWorkBuddyProxy({
      secret: randomProxySecret(),
      accounts: proxyAccounts,
      models: chatModels,
      onAuthFailure: (accountId) => {
        const record = repository.get(accountId)
        if (record === null || record.status === 'expired') return
        repository.setStatus(accountId, 'expired', 'WorkBuddy 拒绝了这次登录，请重新登录', now())
        sessions.delete(accountId)
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
    }
  }

  function snapshot(): WorkBuddySnapshot {
    const records = orderedRecords()
    const preferred =
      preferredId !== null && records.some((record) => record.id === preferredId && record.status !== 'expired')
        ? preferredId
        : (records[0]?.id ?? null)
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
    if (record.authType === 'api') {
      const unclaimed: AccountCheckinRecord = {
        day: localDay(now()),
        at: now(),
        outcome: 'ineligible',
        message: 'API Key 账号不参与签到',
        credit: null,
        streak: null,
      }
      repository.updateCheckin(record.id, unclaimed, now())
      changed()
      return checkinViewOf(unclaimed)
    }
    try {
      const session = await sessionFor(record)
      const result: ClientCheckin = await session.checkin()
      const checkin: AccountCheckinRecord = {
        day: localDay(now()),
        at: now(),
        outcome: result.outcome,
        message: result.message,
        credit: result.credit,
        streak: result.streak,
      }
      repository.updateCheckin(record.id, checkin, now())
      if (result.outcome === 'claimed' || result.outcome === 'done') {
        repository.setStatus(record.id, 'ok', null, now())
        void refreshUsage(record.id).catch((cause) => logger.warn('签到后刷新积分失败', { error: messageOf(cause) }))
      }
      changed()
      return checkinViewOf(checkin)
    } catch (cause) {
      if (manual) throw appErrorOf(cause, { code: workbuddyErrors.checkin_failed, message: 'WorkBuddy 签到失败' })
      logger.warn('自动签到失败', { account: record.id, error: messageOf(cause) })
      throw cause
    }
  }

  async function autoCheckinAll(): Promise<void> {
    if (!autoCheckin) return
    const day = localDay(now())
    for (const record of repository.list()) {
      if (record.authType !== 'oauth' || record.checkin?.day === day) continue
      try {
        await checkinRecord(record, false)
      } catch {
        // checkinRecord 已记日志；今天的自动尝试到此为止，等下一次定时器或用户手动重试。
      }
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
    await Promise.all(
      records.map(async (record) => {
        try {
          const session = await sessionFor(record)
          const usage = await session.usage()
          repository.updateUsage(record.id, usage.plan ?? record.plan, JSON.stringify(usage), now(), now())
          if (usageIsExpired(usage)) {
            repository.setStatus(record.id, 'expired', usage.error ?? 'WorkBuddy 登录已过期', now())
          } else if (usage.error === null) {
            repository.setStatus(record.id, 'ok', null, now())
          }
        } catch (cause) {
          logger.warn('读取 WorkBuddy 积分失败', { account: record.id, error: messageOf(cause) })
          repository.setStatus(record.id, 'error', messageOf(cause), now())
        }
      }),
    )
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
      try {
        await openExternal(signIn.url)
      } catch (cause) {
        logins.delete(loginId)
        throw cause
      }
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
    async addApiKey(apiKey) {
      const key = apiKey.trim()
      const credentials: WorkBuddyCredentials = {
        type: 'api',
        access: key,
        refresh: '',
        expires: 0,
        refreshExpiresAt: 0,
        uid: `anonymous_${key.slice(-8)}`,
        accountId: '',
        domain: '',
        tokenType: '',
        enterpriseId: '',
        key,
      }
      const session = await createSession(credentials, { onUpdate: () => undefined }).catch((cause: unknown) => {
        throw appErrorOf(cause, { code: workbuddyErrors.api_key_invalid, message: 'WorkBuddy 不接受这把 API Key' })
      })
      try {
        await session.validate()
      } catch (cause) {
        throw appErrorOf(cause, { code: workbuddyErrors.api_key_invalid, message: 'WorkBuddy 不接受这把 API Key' })
      }
      const accountId = upsertAccount({ ...credentials, accountId: `API Key ·••••${key.slice(-4)}` }, null)
      changed()
      void syncProxy().catch((cause) => logger.warn('添加账号后启动反代失败', { error: messageOf(cause) }))
      return { accountId }
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
