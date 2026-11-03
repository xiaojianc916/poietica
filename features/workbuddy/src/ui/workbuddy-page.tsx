import {
  Button,
  ConfirmationDialog,
  Dialog,
  LoadingState,
  SettingRow,
  SettingsGroup,
  SettingsPage,
  ToggleRow,
  useCopy,
} from '@poietica/design-system'
import { useFeatureStore } from '@poietica/ui-kernel'
import { CheckCircle2, Plus } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkBuddyAccount, WorkBuddyCheckinOutcome, WorkBuddySnapshot, WorkBuddyUsageWindow } from '../contract'
import type { WorkBuddyApi } from './api'
import { coreGeneration } from './store'
import './workbuddy-settings.css'

const READ_FAILED = '读不到 WorkBuddy 的状态；稍后重试。'

interface LoginView {
  readonly loginId: string
  readonly url: string
  readonly instructions: string
  readonly accountId: string | null
  readonly state: 'waiting' | 'done' | 'failed'
  readonly message: string | null
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function dayLabel(at: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date(at))
}

function remainingOf(window: WorkBuddyUsageWindow): number | null {
  if (window.amount !== null && window.limit !== null) return Math.max(0, window.limit - window.amount)
  return window.balance
}

function windowPercent(window: WorkBuddyUsageWindow): number | null {
  if (window.amount !== null && window.limit !== null && window.limit > 0) {
    return Math.min(100, Math.max(0, (100 * (window.limit - window.amount)) / window.limit))
  }
  return null
}

const CREDIT_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })

function usageLine(window: WorkBuddyUsageWindow): string {
  const remaining = remainingOf(window)
  const value =
    remaining === null
      ? window.display
      : [CREDIT_FORMAT.format(remaining), window.limit === null ? null : CREDIT_FORMAT.format(window.limit)]
          .filter((part) => part !== null)
          .join(' / ')
  return [window.name, value].filter((part) => part !== null).join(' · ')
}

const CREDITS_WINDOW = 'Credits'
const EXTRA_CREDITS_WINDOW = 'Extra credits'

/** 套餐积分与额外积分在界面上合成一格；Core 仍保留两格，选号要读各自的消耗与到期。 */
function isCreditWindow(window: WorkBuddyUsageWindow): boolean {
  return window.name === CREDITS_WINDOW || window.name === EXTRA_CREDITS_WINDOW
}

/** 只有每一格都给得出这个数才相加 —— 缺一格就说明总账算不出来，不拿 0 冒充。 */
function sumIfKnown(values: readonly (number | null)[]): number | null {
  let total = 0
  for (const value of values) {
    if (value === null) return null
    total += value
  }
  return total
}

/** 决定账号停不停的那一格先说话：它上面的到期批次是整号最早作废的那批。 */
function blockingCredit(windows: readonly WorkBuddyUsageWindow[]): WorkBuddyUsageWindow | undefined {
  return windows.find((window) => !window.aside) ?? windows[0]
}

function mergeCreditWindows(windows: readonly WorkBuddyUsageWindow[]): readonly WorkBuddyUsageWindow[] {
  const credits = windows.filter(isCreditWindow)
  const primary = credits[0]
  if (credits.length < 2 || primary === undefined) return windows
  const remaining = sumIfKnown(credits.map(remainingOf))
  const limit = sumIfKnown(credits.map((window) => window.limit))
  const displays = credits.map((window) => window.display)
  const display = displays.every((value) => value !== null) ? displays.join(' + ') : null
  /* amount 是已用，界面的 remainingOf 从 limit - amount 倒推剩余；两格都算得出时才给。 */
  const amount = remaining === null || limit === null ? null : Math.max(0, limit - remaining)
  const blocking = blockingCredit(credits)
  const merged: WorkBuddyUsageWindow = {
    ...primary,
    name: CREDITS_WINDOW,
    used: null,
    amount,
    limit,
    balance: remaining !== null && amount === null ? remaining : null,
    display: amount === null ? display : null,
    runsOutAt: blocking?.runsOutAt ?? primary.runsOutAt,
    runsOut: blocking?.runsOut ?? null,
    refused: blocking?.refused ?? false,
    aside: false,
    notModels: null,
  }
  let inserted = false
  return windows.flatMap((window) => {
    if (!isCreditWindow(window)) return [window]
    if (inserted) return []
    inserted = true
    return [merged]
  })
}

/** 还要等多久：冷却中的号在徽标里说人话，而不是只挂一个「不可用」。 */
function restLabel(account: WorkBuddyAccount): string | null {
  const left = account.restUntil - Date.now()
  if (left <= 0) return null
  const minutes = Math.max(1, Math.ceil(left / 60_000))
  const tail =
    minutes >= 60 ? `${String(Math.floor(minutes / 60))} 小时 ${String(minutes % 60)} 分` : `${String(minutes)} 分钟`
  return `冷却中 · ${tail}后重试`
}

function todayKey(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const CHECKIN_LABEL: Record<WorkBuddyCheckinOutcome, string> = {
  done: '已签到',
  claimed: '已签到',
  failed: '失败',
  ineligible: '不可用',
  inactive: '未开放',
}

function checkinTextOf(account: WorkBuddyAccount): string | null {
  const checkin = account.checkin
  if (checkin === null) return null
  if (account.checkedInToday) {
    const credit = checkin.credit === null ? '' : ` +${String(checkin.credit)}`
    const streak = checkin.streak === null ? '' : ` · 连续 ${String(checkin.streak)} 天`
    return `今日已签到${credit}${streak}`
  }
  if (checkin.day === todayKey()) {
    return `今日签到：${CHECKIN_LABEL[checkin.outcome]}${checkin.message === null ? '' : ` · ${checkin.message}`}`
  }
  return `上次签到 ${dayLabel(checkin.at)}`
}

function CreditsView({ account }: { readonly account: WorkBuddyAccount }) {
  const usage = account.usage
  if (usage === null) return <p className="workbuddy-account__muted">积分尚未读取，点右上角刷新。</p>
  if (usage.windows.length === 0) {
    const empty =
      account.kind === 'api_key' ? 'API Key 账号不提供积分读数。' : (usage.error ?? '上游没有返回积分窗口。')
    return <p className="workbuddy-account__muted">{empty}</p>
  }
  return (
    <>
      {mergeCreditWindows(usage.windows).map((window) => {
        const percent = windowPercent(window)
        return (
          <div className="workbuddy-credit" key={window.name}>
            <div className="workbuddy-credit__line">
              <span>{usageLine(window)}</span>
              <span className="workbuddy-credit__marks">
                {window.runsOut === null ? null : <span>{`${CREDIT_FORMAT.format(window.runsOut)} 积分即将到期`}</span>}
                {window.refused ? <span className="workbuddy-badge workbuddy-badge--warning">已用尽</span> : null}
              </span>
            </div>
            {percent === null ? null : (
              <div
                aria-label={`${window.name} 剩余 ${String(Math.round(percent))}%`}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={Math.round(percent)}
                className="workbuddy-credit__track"
                role="progressbar"
              >
                <span style={{ inlineSize: `${String(percent)}%` }} />
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

function AccountActions({
  account,
  busy,
  onCheckin,
  onPreferred,
  onRelogin,
  onRemove,
}: {
  readonly account: WorkBuddyAccount
  readonly busy: string | null
  readonly onCheckin: (account: WorkBuddyAccount) => void
  readonly onPreferred: (account: WorkBuddyAccount) => void
  readonly onRelogin: (account: WorkBuddyAccount) => void
  readonly onRemove: (account: WorkBuddyAccount) => void
}) {
  const checkinBusy = busy === `checkin:${account.id}`
  return (
    <div className="workbuddy-account__actions">
      {account.preferred ? (
        <span className="workbuddy-preferred">首选</span>
      ) : (
        <Button onClick={() => onPreferred(account)} size="xs" type="button" variant="ghost">
          设为首选
        </Button>
      )}
      <Button disabled={busy !== null} onClick={() => onRelogin(account)} size="xs" type="button" variant="ghost">
        重新登录
      </Button>
      {account.kind === 'browser' ? (
        <Button
          disabled={checkinBusy || busy !== null || account.checkedInToday}
          onClick={() => onCheckin(account)}
          size="xs"
          type="button"
          variant="ghost"
        >
          {checkinBusy ? '签到中…' : account.checkedInToday ? '今日已签到' : '签到'}
        </Button>
      ) : null}
      <Button disabled={busy !== null} onClick={() => onRemove(account)} size="xs" type="button" variant="dangerSoft">
        移除
      </Button>
    </div>
  )
}

function AccountRow({
  account,
  busy,
  onCheckin,
  onPreferred,
  onRelogin,
  onRemove,
}: {
  readonly account: WorkBuddyAccount
  readonly busy: string | null
  readonly onCheckin: (account: WorkBuddyAccount) => void
  readonly onPreferred: (account: WorkBuddyAccount) => void
  readonly onRelogin: (account: WorkBuddyAccount) => void
  readonly onRemove: (account: WorkBuddyAccount) => void
}) {
  const checkinText = checkinTextOf(account)

  return (
    <article className="workbuddy-account">
      <div className="workbuddy-account__head">
        <span
          aria-hidden="true"
          className="workbuddy-account__mark"
          data-preferred={account.preferred ? 'true' : undefined}
        >
          {account.preferred ? <CheckCircle2 /> : null}
        </span>
        <div className="workbuddy-account__identity">
          <strong>{account.label}</strong>
          <span className="workbuddy-badge">
            {account.plan ?? account.usage?.plan ?? (account.kind === 'api_key' ? 'API Key' : '未读取套餐')}
          </span>
          {account.status === 'expired' ? (
            <span className="workbuddy-badge workbuddy-badge--warning">需要重新登录</span>
          ) : null}
          {account.status === 'error' ? (
            <span className="workbuddy-badge workbuddy-badge--danger">读取失败</span>
          ) : null}
          {restLabel(account) === null ? null : (
            <span className="workbuddy-badge workbuddy-badge--warning">{restLabel(account)}</span>
          )}
        </div>
        <AccountActions
          account={account}
          busy={busy}
          onCheckin={onCheckin}
          onPreferred={onPreferred}
          onRelogin={onRelogin}
          onRemove={onRemove}
        />
      </div>

      <div className="workbuddy-account__credits">
        <CreditsView account={account} />
        {checkinText === null ? null : <p className="workbuddy-account__checkin">{checkinText}</p>}
        {account.statusMessage !== null && account.status !== 'expired' ? (
          <p className="workbuddy-account__error">{account.statusMessage}</p>
        ) : null}
        {account.restReason === null ? null : <p className="workbuddy-account__muted">{account.restReason}</p>}
      </div>
    </article>
  )
}

function LoginStatus({ login }: { readonly login: LoginView }) {
  if (login.state === 'waiting') {
    return (
      <p className="workbuddy-login__waiting" role="status">
        等待浏览器完成授权…
      </p>
    )
  }
  if (login.state === 'failed') {
    return (
      <p className="settings-error" role="alert">
        {login.message ?? '登录失败'}
      </p>
    )
  }
  return null
}

function LoginDialog({
  login,
  onCancel,
  onOpenUrl,
}: {
  readonly login: LoginView
  readonly onCancel: () => void
  readonly onOpenUrl: (url: string) => Promise<void>
}) {
  const { copied, copy } = useCopy()
  const [opening, setOpening] = useState(false)
  const [opened, setOpened] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const autoOpened = useRef(false)
  const alive = useRef(true)

  const open = useCallback(async (): Promise<void> => {
    setOpening(true)
    setOpenError(null)
    try {
      await onOpenUrl(login.url)
      if (alive.current) setOpened(true)
    } catch (cause) {
      if (alive.current) setOpenError(messageOf(cause))
    } finally {
      if (alive.current) setOpening(false)
    }
  }, [login.url, onOpenUrl])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (autoOpened.current) return
    autoOpened.current = true
    void open()
  }, [open])

  return (
    <Dialog
      closeOnOverlayClick={false}
      footer={
        <Button onClick={onCancel} size="sm" type="button" variant="ghost">
          {login.state === 'waiting' ? '取消' : '关闭'}
        </Button>
      }
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
      open
      title="WorkBuddy 登录"
    >
      <div className="workbuddy-login">
        <p>{login.instructions}</p>
        <p className="workbuddy-login__url">{login.url}</p>
        <div className="workbuddy-login__actions">
          <Button disabled={opening} onClick={() => void open()} size="sm" type="button" variant="secondary">
            {opening ? '正在打开…' : '在浏览器中打开'}
          </Button>
          <Button onClick={() => copy(login.url)} size="sm" type="button" variant="ghost">
            {copied ? '已复制' : '复制链接'}
          </Button>
        </div>
        {opened ? (
          <p className="workbuddy-login__hint" role="status">
            已请求系统浏览器打开；如果没看到浏览器，请复制链接后手动打开。
          </p>
        ) : null}
        {openError === null ? null : (
          <p className="settings-error" role="alert">
            打开浏览器失败：{openError}
          </p>
        )}
        <LoginStatus login={login} />
      </div>
    </Dialog>
  )
}

const PROVIDER_TEXT: Record<WorkBuddySnapshot['proxy']['providerState'], string> = {
  disabled: '未启用',
  registered: '已注册为模型服务商',
  missing: '未注册',
  conflict: 'workbuddy 已被占用',
  error: '注册失败',
}

function AccountsGroup({
  accounts,
  busy,
  onAdd,
  onCheckin,
  onPreferred,
  onRefresh,
  onRelogin,
  onRemove,
}: {
  readonly accounts: readonly WorkBuddyAccount[]
  readonly busy: string | null
  readonly onAdd: () => void
  readonly onCheckin: (account: WorkBuddyAccount) => void
  readonly onPreferred: (account: WorkBuddyAccount) => void
  readonly onRefresh: () => void
  readonly onRelogin: (account: WorkBuddyAccount) => void
  readonly onRemove: (account: WorkBuddyAccount) => void
}) {
  return (
    <SettingsGroup
      headerAction={
        <Button disabled={busy !== null} onClick={onRefresh} size="xs" type="button" variant="ghost">
          {busy === 'usage' ? '刷新中…' : '刷新积分'}
        </Button>
      }
      title="账号"
    >
      {accounts.length === 0 ? (
        <p className="workbuddy-empty">还没有 WorkBuddy 账号。登录后，这里会显示套餐、积分和每日签到。</p>
      ) : (
        accounts.map((account) => (
          <AccountRow
            account={account}
            busy={busy}
            key={account.id}
            onCheckin={onCheckin}
            onPreferred={onPreferred}
            onRelogin={onRelogin}
            onRemove={onRemove}
          />
        ))
      )}
      <button className="workbuddy-add" disabled={busy !== null} onClick={onAdd} type="button">
        <Plus aria-hidden="true" />
        添加 WorkBuddy 账号
      </button>
    </SettingsGroup>
  )
}

function ProxyGroup({
  autoCheckin,
  busy,
  hasAccounts,
  onAutoCheckin,
  onEnabled,
  onRepair,
  proxy,
}: {
  readonly autoCheckin: boolean
  readonly busy: string | null
  readonly hasAccounts: boolean
  readonly onAutoCheckin: (enabled: boolean) => void
  readonly onEnabled: (enabled: boolean) => void
  readonly onRepair: () => void
  readonly proxy: WorkBuddySnapshot['proxy']
}) {
  return (
    <SettingsGroup title="反代">
      <ToggleRow
        checked={proxy.enabled}
        description="只监听本机，只把 OpenAI 兼容的对话请求转发到 WorkBuddy；不代理其它站点。"
        label="启用内置反代"
        onChange={onEnabled}
      />
      <SettingRow description="omp 用这条地址访问本地反代。" label="本地端点">
        <code className="workbuddy-endpoint">{proxy.endpoint ?? '未启动'}</code>
      </SettingRow>
      <SettingRow
        /* 冲突时这句话已经挂在 warning 上：同一句再当 description 就是上下各一遍 */
        description={
          proxy.providerState === 'conflict'
            ? '注册后会在「模型」里出现 WorkBuddy 服务商。'
            : (proxy.providerMessage ?? '注册后会在「模型」里出现 WorkBuddy 服务商。')
        }
        label="模型服务商"
        warning={proxy.providerState === 'conflict' ? (proxy.providerMessage ?? undefined) : undefined}
      >
        <span className="workbuddy-account__muted">{PROVIDER_TEXT[proxy.providerState]}</span>
        {hasAccounts && proxy.enabled && proxy.providerState !== 'registered' ? (
          <Button disabled={busy !== null} onClick={onRepair} size="xs" type="button" variant="ghost">
            重新注册
          </Button>
        ) : null}
      </SettingRow>
      <ToggleRow
        checked={autoCheckin}
        description="应用运行时，每天第一次打开就替所有已登录账号领一次；失败会在账号下写明。"
        label="每日自动签到"
        onChange={onAutoCheckin}
      />
    </SettingsGroup>
  )
}

export function WorkBuddyPage({
  api,
  openUrl,
}: {
  readonly api: WorkBuddyApi
  readonly openUrl: (url: string) => Promise<void>
}) {
  const [snapshot, setSnapshot] = useState<WorkBuddySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [login, setLogin] = useState<LoginView | null>(null)
  const [removeTarget, setRemoveTarget] = useState<WorkBuddyAccount | null>(null)
  const generation = useFeatureStore(coreGeneration, (state) => state.value)
  const loadedGeneration = useRef(generation)

  const reload = useCallback(async () => {
    try {
      setSnapshot(await api.snapshot())
      setError(null)
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [api])

  useEffect(() => {
    if (loadedGeneration.current === generation) return
    loadedGeneration.current = generation
    setLogin((current) =>
      current !== null && current.state === 'waiting'
        ? { ...current, state: 'failed', message: 'Core 已重启，请重新发起登录' }
        : current,
    )
    void reload()
  }, [generation, reload])

  useEffect(() => {
    void reload()
    const changed = api.onChanged(() => {
      void reload()
    })
    return () => changed.dispose()
  }, [api, reload])

  useEffect(() => {
    const events = api.onLoginEvent((event) => {
      setLogin((current) => {
        if (current === null || current.loginId !== event.loginId) return current
        return { ...current, state: event.state, message: event.message }
      })
      if (event.state === 'done') {
        setLogin(null)
        void reload()
      }
    })
    return () => events.dispose()
  }, [api, reload])

  useEffect(() => {
    if (login === null || login.state !== 'waiting') return
    const timer = setTimeout(
      () => {
        void api.cancelLogin(login.loginId).catch(() => undefined)
        setLogin((current) =>
          current !== null && current.loginId === login.loginId && current.state === 'waiting'
            ? { ...current, state: 'failed', message: '登录超时，请重新点击浏览器登录' }
            : current,
        )
      },
      6 * 60 * 1000,
    )
    return () => clearTimeout(timer)
  }, [api, login])

  const accounts = snapshot?.accounts ?? []

  const run = useCallback(async (key: string, task: () => Promise<WorkBuddySnapshot | undefined>) => {
    setBusy(key)
    setError(null)
    try {
      const next = await task()
      if (next !== undefined) setSnapshot(next)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }, [])

  const startLogin = useCallback(
    async (accountId: string | null) => {
      setBusy('login')
      setError(null)
      try {
        const started = await api.startBrowserLogin(accountId)
        setLogin({
          loginId: started.loginId,
          url: started.url,
          instructions: started.instructions,
          accountId,
          state: 'waiting',
          message: null,
        })
      } catch (cause) {
        setError(messageOf(cause))
      } finally {
        setBusy(null)
      }
    },
    [api],
  )

  const cancelLogin = useCallback(() => {
    if (login !== null) void api.cancelLogin(login.loginId).catch(() => undefined)
    setLogin(null)
  }, [api, login])

  const removeAccount = useCallback(async () => {
    if (removeTarget === null) return
    setBusy('remove')
    try {
      await api.removeAccount(removeTarget.id)
      setRemoveTarget(null)
      await reload()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }, [api, reload, removeTarget])

  const checkin = useCallback(
    async (account: WorkBuddyAccount) => {
      setBusy(`checkin:${account.id}`)
      setError(null)
      try {
        await api.checkin(account.id)
        await reload()
      } catch (cause) {
        setError(messageOf(cause))
      } finally {
        setBusy(null)
      }
    },
    [api, reload],
  )

  if (snapshot === null) {
    return error === null ? (
      <LoadingState />
    ) : (
      <p className="settings-error">
        {READ_FAILED}
        {error}
      </p>
    )
  }

  return (
    <SettingsPage>
      {error === null ? null : (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}

      <AccountsGroup
        accounts={accounts}
        busy={busy}
        onAdd={() => void startLogin(null)}
        onCheckin={(item) => void checkin(item)}
        onPreferred={(item) => void run(`preferred:${item.id}`, () => api.setPreferred(item.id))}
        onRefresh={() => void run('usage', () => api.refreshUsage(null))}
        onRelogin={(item) => void startLogin(item.id)}
        onRemove={setRemoveTarget}
      />

      <ProxyGroup
        autoCheckin={snapshot.autoCheckin}
        busy={busy}
        hasAccounts={accounts.length > 0}
        onAutoCheckin={(next) => void run('auto', () => api.setAutoCheckin(next))}
        onEnabled={(next) => void run('enabled', () => api.setEnabled(next))}
        onRepair={() => void run('repair', () => api.repairProvider())}
        proxy={snapshot.proxy}
      />

      {login === null ? null : <LoginDialog login={login} onCancel={cancelLogin} onOpenUrl={(url) => openUrl(url)} />}

      <ConfirmationDialog
        busy={busy === 'remove'}
        confirmLabel="移除"
        description={`移除后，这个账号的令牌和积分缓存会从本机删除。${removeTarget?.preferred === true ? '它是当前首选账号，移除后会自动换下一个。' : ''}`}
        destructive
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => void removeAccount()}
        open={removeTarget !== null}
        title={`移除 ${removeTarget?.label ?? ''}？`}
      />
    </SettingsPage>
  )
}
