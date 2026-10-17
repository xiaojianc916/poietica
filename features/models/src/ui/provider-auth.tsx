import { Button, SegmentedControl, type SegmentedOption } from '@poietica/design-system'
import { type FormEvent, type ReactNode, useCallback, useMemo, useState } from 'react'
import type { LoginProvider } from '../contract'
import { type AccountLogin, useAccountLogin, useLoginDirectory } from './account-login'
import type { ModelsApi } from './api'
import { SecretInput } from './secret-input'

/**
 * 一家内置服务商的「怎么认证」：账号登录或 API Key，二选一地摆在这家服务商自己的面板里
 * （Cursor / Codex 的设置都这么放：认证跟着服务商走，不另起一组）。
 * 只有 omp 说这家支持账号登录时才出现切换；OpenRouter 这类「浏览器里授权、换回一把 Key」的，算 API Key 的一种取法。
 */

type Method = 'account' | 'api_key'

const METHODS = [
  { value: 'account', label: '账号登录' },
  { value: 'api_key', label: 'API Key' },
] as const satisfies readonly SegmentedOption<Method>[]

export interface ProviderAuthProps {
  readonly providerId: string
  /** omp 说这家此刻能用（有 Key、登录过、环境变量……任一来源） */
  readonly configured: boolean
  readonly disabled?: boolean
  /** 保存 Key 的那颗按钮叫什么（从目录添加时是「添加」） */
  readonly submitLabel?: string
  /** Key 存好或账号登录成功之后（从目录添加那一页靠它收尾） */
  readonly onAuthorized?: () => void | Promise<void>
}

/** 模型页拿到的认证插槽：服务商面板画认证区、目录行和头部问一句「这家登录了没有」 */
export interface ProviderAuthSlot {
  readonly signedIn: (providerId: string) => boolean
  readonly canSignIn: (providerId: string) => boolean
  readonly render: (props: ProviderAuthProps) => ReactNode
}

export function useProviderAuth(api: ModelsApi): { readonly slot: ProviderAuthSlot; readonly dialog: ReactNode } {
  const directory = useLoginDirectory(api)
  const login = useAccountLogin(api)
  const { start } = login
  const slot = useMemo<ProviderAuthSlot>(
    () => ({
      signedIn: (providerId) => directory.get(providerId)?.authenticated === true,
      canSignIn: (providerId) => {
        const entry = directory.get(providerId)
        return entry !== undefined && !entry.issuesApiKey
      },
      render: (props) => <ProviderAuth api={api} entry={directory.get(props.providerId)} start={start} {...props} />,
    }),
    [api, directory, start],
  )
  return { slot, dialog: login.dialog }
}

function ProviderAuth({
  api,
  entry,
  start,
  providerId,
  configured,
  disabled = false,
  submitLabel = '保存',
  onAuthorized,
}: ProviderAuthProps & {
  readonly api: ModelsApi
  readonly entry: LoginProvider | undefined
  readonly start: AccountLogin['start']
}) {
  const accountCapable = entry !== undefined && !entry.issuesApiKey
  const signedIn = entry?.authenticated === true
  /* 有账号登录时 configured 多半来自它；这时 API Key 那一栏不该说「已保存」 */
  const keySaved = configured && !signedIn
  const [picked, setPicked] = useState<Method | null>(null)
  const fallback: Method = signedIn ? 'account' : keySaved ? 'api_key' : 'account'
  const method: Method = accountCapable ? (picked ?? fallback) : 'api_key'

  const signIn = useCallback(() => {
    if (entry !== undefined) start(entry, () => void onAuthorized?.())
  }, [entry, onAuthorized, start])

  return (
    <div className="models-auth">
      {accountCapable ? (
        <SegmentedControl
          className="models-auth__methods"
          label="认证方式"
          name={`models-auth-${providerId}`}
          onValueChange={setPicked}
          options={METHODS}
          value={method}
        />
      ) : null}
      {method === 'account' && entry !== undefined ? (
        <AccountSection api={api} disabled={disabled} entry={entry} onSignIn={signIn} />
      ) : (
        <ApiKeySection
          api={api}
          disabled={disabled}
          keySaved={keySaved}
          onAuthorized={onAuthorized}
          providerId={providerId}
          submitLabel={submitLabel}
          {...(entry?.issuesApiKey === true ? { onFetchKey: signIn } : {})}
        />
      )}
    </div>
  )
}

function AccountSection({
  api,
  entry,
  disabled,
  onSignIn,
}: {
  readonly api: ModelsApi
  readonly entry: LoginProvider
  readonly disabled: boolean
  readonly onSignIn: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!entry.authenticated) {
    return (
      <div className="models-auth__row">
        <div className="models-auth__copy">
          <span className="models-auth__title">{entry.name}</span>
          <span className="models-auth__sub">使用订阅账号登录，无需 API Key。</span>
        </div>
        <Button disabled={disabled} onClick={onSignIn} size="xs" type="button">
          登录
        </Button>
      </div>
    )
  }
  const logout = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.logout(entry.provider)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '退出登录失败，请重试。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="models-auth__row">
        <div className="models-auth__copy">
          <span className="models-auth__title">已登录</span>
          <span className="models-auth__sub">{entry.account ?? entry.name}</span>
        </div>
        <div className="models-auth__actions">
          <Button disabled={disabled || busy} onClick={() => void logout()} size="xs" type="button" variant="ghost">
            退出登录
          </Button>
          <Button disabled={disabled || busy} onClick={onSignIn} size="xs" type="button" variant="soft">
            切换账号
          </Button>
        </div>
      </div>
      {error === null ? null : <p className="models-auth__error">{error}</p>}
    </>
  )
}

function ApiKeySection({
  api,
  providerId,
  keySaved,
  disabled,
  submitLabel,
  onAuthorized,
  onFetchKey,
}: {
  readonly api: ModelsApi
  readonly providerId: string
  readonly keySaved: boolean
  readonly disabled: boolean
  readonly submitLabel: string
  readonly onAuthorized: (() => void | Promise<void>) | undefined
  readonly onFetchKey?: () => void
}) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: () => Promise<void>, failure: string) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      return true
    } catch (cause) {
      setError(cause instanceof Error && cause.message !== '' ? cause.message : failure)
      return false
    } finally {
      setBusy(false)
    }
  }
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const key = value.trim()
    if (key === '') return
    const ok = await run(() => api.setApiKey(providerId, key), '保存失败，请重试。')
    if (ok) {
      setValue('')
      await onAuthorized?.()
    }
  }
  const locked = disabled || busy
  return (
    <form className="models-auth__key" onSubmit={(event) => void save(event)}>
      <div className="models-auth__key-row">
        <SecretInput
          aria-label="API Key"
          autoComplete="new-password"
          disabled={locked}
          onChange={(event) => setValue(event.target.value)}
          placeholder={keySaved ? '已保存，输入新的 Key 以替换' : '粘贴 API Key'}
          value={value}
        />
        <Button disabled={locked || value.trim() === ''} size="xs" type="submit">
          {submitLabel}
        </Button>
        {keySaved ? (
          <Button
            disabled={locked}
            onClick={() => void run(() => api.clearApiKey(providerId), '移除失败，请重试。')}
            size="xs"
            type="button"
            variant="ghost"
          >
            移除
          </Button>
        ) : null}
      </div>
      {onFetchKey === undefined ? null : (
        <button className="models-auth__fetch" disabled={locked} onClick={onFetchKey} type="button">
          没有 Key？在浏览器中登录获取
        </button>
      )}
      {error === null ? null : <p className="models-auth__error">{error}</p>}
    </form>
  )
}
