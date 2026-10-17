import { Button, Select, SettingRow, SettingsGroup } from '@poietica/design-system'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import type { LoginEvent, LoginProvider } from '../contract'
import type { ModelsApi } from './api'

/**
 * 「订阅登录」那一组：Claude Pro/Max、ChatGPT/Codex、GitHub Copilot 这类按账号计费的服务商（omp 的 getOAuthProviders）。
 * 名单、流程、凭据全归 omp：这里只把它要打开的网址交给系统浏览器、把它要人填的那一格画出来，结局只看它报回的身份。
 */

interface FlowView {
  readonly loginId: string
  readonly providerId: string
  readonly url: string | null
  readonly instructions: string | null
  readonly progress: string | null
  readonly prompt: Extract<LoginEvent, { kind: 'prompt' }> | null
  readonly outcome: { readonly ok: boolean; readonly text: string } | null
}

function reduce(flow: FlowView, event: LoginEvent): FlowView {
  switch (event.kind) {
    case 'auth':
      return { ...flow, url: event.launchUrl ?? event.url, instructions: event.instructions }
    case 'progress':
      return { ...flow, progress: event.message }
    case 'prompt':
      return { ...flow, prompt: event }
    case 'done': {
      const who = event.identity?.email ?? event.identity?.orgName ?? null
      return { ...flow, prompt: null, outcome: { ok: true, text: who === null ? '已登录' : `已登录：${who}` } }
    }
    case 'failed':
      return { ...flow, prompt: null, outcome: { ok: false, text: event.message } }
  }
}

/* 事件可能比 startLogin 的回执先到：按 loginId 先收着，回执到了再认领 */
function useLoginFlow(api: ModelsApi) {
  const [flow, setFlow] = useState<FlowView | null>(null)
  const [early] = useState(() => new Map<string, LoginEvent[]>())

  useEffect(() => {
    const sub = api.onLoginEvent(({ loginId, event }) => {
      if (event.kind === 'auth') window.open(event.launchUrl ?? event.url, '_blank', 'noopener')
      setFlow((current) => {
        if (current?.loginId === loginId) return reduce(current, event)
        early.set(loginId, [...(early.get(loginId) ?? []), event])
        return current
      })
    })
    return () => sub.dispose()
  }, [api, early])

  const start = useCallback(
    async (providerId: string) => {
      const loginId = await api.startLogin(providerId)
      const seed: FlowView = {
        loginId,
        providerId,
        url: null,
        instructions: null,
        progress: null,
        prompt: null,
        outcome: null,
      }
      const held = early.get(loginId) ?? []
      early.delete(loginId)
      setFlow(held.reduce(reduce, seed))
    },
    [api, early],
  )

  const close = useCallback(() => {
    setFlow((current) => {
      if (current !== null && current.outcome === null) void api.cancelLogin(current.loginId)
      return null
    })
  }, [api])

  return { close, flow, start }
}

function PromptForm({ api, flow }: { readonly api: ModelsApi; readonly flow: FlowView }) {
  const [value, setValue] = useState('')
  const prompt = flow.prompt
  if (prompt === null) return null
  const blocked = value === '' && !prompt.allowEmpty
  return (
    <form
      className="models-login__prompt"
      onSubmit={(event) => {
        event.preventDefault()
        if (blocked) return
        void api.answerLogin(flow.loginId, prompt.promptId, value)
        setValue('')
      }}
    >
      <label className="models-login__label">
        {prompt.message}
        <input
          autoComplete="off"
          className="settings-input"
          onChange={(event) => setValue(event.target.value)}
          placeholder={prompt.placeholder ?? undefined}
          type={prompt.secret ? 'password' : 'text'}
          value={value}
        />
      </label>
      <Button disabled={blocked} size="sm" type="submit">
        提交
      </Button>
    </form>
  )
}

function FlowPanel({
  api,
  flow,
  onClose,
}: {
  readonly api: ModelsApi
  readonly flow: FlowView
  readonly onClose: () => void
}) {
  return (
    <div className="models-login__flow" role="status">
      {flow.url === null ? null : (
        <p className="models-login__line">
          已在浏览器打开授权页；没有弹出就{' '}
          <a href={flow.url} rel="noreferrer" target="_blank">
            点这里打开
          </a>
          。
        </p>
      )}
      {flow.instructions === null ? null : <p className="models-login__line">{flow.instructions}</p>}
      {flow.progress === null || flow.outcome !== null ? null : <p className="models-login__line">{flow.progress}</p>}
      <PromptForm api={api} flow={flow} key={flow.prompt?.promptId ?? 'none'} />
      {flow.outcome === null ? null : (
        <p className="models-login__line" data-ok={flow.outcome.ok ? 'true' : 'false'}>
          {flow.outcome.text}
        </p>
      )}
      <Button onClick={onClose} size="sm" variant="ghost">
        {flow.outcome === null ? '取消登录' : '关闭'}
      </Button>
    </div>
  )
}

export function SubscriptionLogins({ api }: { readonly api: ModelsApi }): ReactNode {
  const [providers, setProviders] = useState<readonly LoginProvider[]>([])
  const [picked, setPicked] = useState<string | null>(null)
  const { close, flow, start } = useLoginFlow(api)

  useEffect(() => {
    const load = () => {
      void api.loginProviders().then(setProviders)
    }
    load()
    const sub = api.onChanged(load)
    return () => sub.dispose()
  }, [api])

  /* omp 的名单有几十家（含插件注册的）：没登过的收进一个下拉，登过的才各占一行 */
  const signedIn = providers.filter((provider) => provider.available && provider.authenticated)
  const choices = providers.filter((provider) => provider.available && !provider.authenticated)
  if (signedIn.length === 0 && choices.length === 0) return null
  const busy = flow !== null && flow.outcome === null
  const target = picked ?? choices[0]?.id ?? null

  return (
    <SettingsGroup title="订阅登录">
      {choices.length === 0 ? null : (
        <SettingRow description="Claude Pro/Max、ChatGPT、GitHub Copilot 等订阅账号" label="用账号登录">
          <span className="models-login__actions">
            <Select
              align="end"
              className="settings-select-trigger"
              data={choices.map((provider) => ({ value: provider.id, label: provider.name }))}
              onValueChange={setPicked}
              type="订阅服务商"
              value={target ?? ''}
            />
            <Button
              disabled={busy || target === null}
              onClick={() => {
                if (target !== null) void start(target)
              }}
              size="sm"
              variant="outline"
            >
              登录
            </Button>
          </span>
        </SettingRow>
      )}
      {signedIn.map((provider) => (
        <SettingRow description="已有凭据" key={provider.id} label={provider.name}>
          <span className="models-login__actions">
            <Button onClick={() => void api.clearApiKey(provider.provider)} size="sm" variant="ghost">
              退出
            </Button>
            <Button disabled={busy} onClick={() => void start(provider.id)} size="sm" variant="outline">
              重新登录
            </Button>
          </span>
        </SettingRow>
      ))}
      {flow === null ? null : <FlowPanel api={api} flow={flow} onClose={close} />}
    </SettingsGroup>
  )
}
