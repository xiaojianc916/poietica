import { Button, Dialog, focusOnMount, InlineSpinner, useCopy } from '@poietica/design-system'
import { Check, CircleAlert, CircleCheck, Copy, ExternalLink } from 'lucide-react'
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LoginEvent, LoginProvider } from '../contract'
import type { ModelsApi } from './api'

/**
 * 账号登录（Claude Pro/Max、ChatGPT、GitHub Copilot 这类按订阅计费的服务商）。流程、凭据全归 omp：
 * 这里只把它要打开的网址交给浏览器、把它要人填的那一格画出来，结局只看它报回的身份。
 * 界面跟 Codex / Claude Code 的登录同一个样子：一个对话框，一句当前在等什么，必要时给验证码或一格输入。
 */

type PromptEvent = Extract<LoginEvent, { kind: 'prompt' }>

interface FlowState {
  /** startLogin 回执到之前是 null（对话框先开着，显示「正在打开授权页」） */
  readonly loginId: string | null
  readonly entry: LoginProvider
  readonly auth: { readonly url: string; readonly code: string | null; readonly instructions: string | null } | null
  readonly progress: string | null
  /** 必须填了才能往下走的那一格（组织名、企业域名……） */
  readonly prompt: PromptEvent | null
  /** 浏览器回调的备用通道：没自动跳回时才用得着 */
  readonly fallback: PromptEvent | null
  /** `key` = 这次「登录」换回的是一把 API Key（OpenRouter 这类），不是账号 */
  readonly outcome:
    | { readonly ok: true; readonly account: string | null; readonly key: boolean }
    | { readonly ok: false; readonly message: string }
    | null
}

function reduce(flow: FlowState, event: LoginEvent): FlowState {
  switch (event.kind) {
    case 'auth':
      return {
        ...flow,
        auth: { url: event.launchUrl ?? event.url, code: event.code, instructions: event.instructions },
      }
    case 'progress':
      return { ...flow, progress: event.message }
    case 'prompt':
      return event.fallback ? { ...flow, fallback: event } : { ...flow, prompt: event }
    case 'done':
      return {
        ...flow,
        prompt: null,
        fallback: null,
        outcome: {
          ok: true,
          account: event.identity?.email ?? event.identity?.orgName ?? null,
          key: event.identity?.kind === 'api_key',
        },
      }
    case 'failed':
      return { ...flow, prompt: null, fallback: null, outcome: { ok: false, message: event.message } }
  }
}

/** omp 的登录名单按「凭据记在哪一家」归并：一家有几条流程时（ChatGPT 的浏览器 / 设备码），取与它同名的那条 */
export function useLoginDirectory(api: ModelsApi): ReadonlyMap<string, LoginProvider> {
  const [entries, setEntries] = useState<readonly LoginProvider[]>([])
  useEffect(() => {
    let live = true
    const load = () => {
      /* 读不到名单就沿用上一次的：这一格只是「这家能不能账号登录」的判据，不该让整个面板崩掉 */
      void api
        .loginProviders()
        .then((next) => {
          if (live) setEntries(next)
        })
        .catch(() => undefined)
    }
    load()
    const sub = api.onChanged(load)
    return () => {
      live = false
      sub.dispose()
    }
  }, [api])
  return useMemo(() => {
    const byProvider = new Map<string, LoginProvider>()
    for (const entry of entries) {
      if (!entry.available) continue
      const held = byProvider.get(entry.provider)
      if (held === undefined || (held.id !== entry.provider && entry.id === entry.provider)) {
        byProvider.set(entry.provider, entry)
      }
    }
    return byProvider
  }, [entries])
}

export interface AccountLogin {
  /** 打开登录对话框走一遍；`onDone` 在登录成功时调一次（对话框还开着，等人点「完成」） */
  readonly start: (entry: LoginProvider, onDone?: () => void) => void
  /** 页面里挂一次的对话框 */
  readonly dialog: ReactNode
}

export function useAccountLogin(api: ModelsApi): AccountLogin {
  const [flow, setFlow] = useState<FlowState | null>(null)
  /* 事件可能比 startLogin 的回执先到：按 loginId 先收着，回执到了再认领 */
  const early = useRef(new Map<string, LoginEvent[]>())
  const onDone = useRef<(() => void) | undefined>(undefined)

  useEffect(() => {
    const sub = api.onLoginEvent(({ loginId, event }) => {
      if (event.kind === 'auth') window.open(event.launchUrl ?? event.url, '_blank', 'noopener')
      if (event.kind === 'done') onDone.current?.()
      setFlow((current) => {
        if (current !== null && current.loginId === loginId) return reduce(current, event)
        early.current.set(loginId, [...(early.current.get(loginId) ?? []), event])
        return current
      })
    })
    return () => sub.dispose()
  }, [api])

  const start = useCallback(
    (entry: LoginProvider, done?: () => void) => {
      onDone.current = done
      setFlow({ loginId: null, entry, auth: null, progress: null, prompt: null, fallback: null, outcome: null })
      api.startLogin(entry.id).then(
        (loginId) => {
          const held = early.current.get(loginId) ?? []
          early.current.delete(loginId)
          setFlow((current) =>
            current === null || current.entry.id !== entry.id ? current : held.reduce(reduce, { ...current, loginId }),
          )
        },
        (cause: unknown) => {
          const message = cause instanceof Error ? cause.message : String(cause)
          setFlow((current) => (current === null ? current : { ...current, outcome: { ok: false, message } }))
        },
      )
    },
    [api],
  )

  /* 关掉与交回一格都要用到「此刻的流程」：放进 ref 读，副作用不写进 setState 的更新函数里 */
  const latest = useRef(flow)
  latest.current = flow

  const close = useCallback(() => {
    const live = latest.current
    /* 取消是收尾动作：对话框已经要关了，取消失败（这次登录早就结束了）不该再弹一条错 */
    if (live?.loginId != null && live.outcome === null) {
      api.cancelLogin(live.loginId).catch(() => undefined)
    }
    setFlow(null)
  }, [api])

  const answer = useCallback(
    (prompt: PromptEvent, value: string) => {
      const loginId = latest.current?.loginId
      if (loginId == null) return
      setFlow((live) => {
        if (live === null) return live
        return prompt.fallback ? { ...live, fallback: null, progress: '正在完成登录…' } : { ...live, prompt: null }
      })
      /* 交不回去（这次登录已经结束、这一格已答过）要说出来：否则那一格消失、对话框永远停在等待 */
      api.answerLogin(loginId, prompt.promptId, value).catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        setFlow((live) => (live === null ? live : { ...live, outcome: { ok: false, message } }))
      })
    },
    [api],
  )

  const dialog = (
    <AccountLoginDialog
      flow={flow}
      onAnswer={answer}
      onClose={close}
      onRetry={() => {
        if (flow !== null) start(flow.entry, onDone.current)
      }}
    />
  )
  return { start, dialog }
}

function AccountLoginDialog({
  flow,
  onAnswer,
  onClose,
  onRetry,
}: {
  readonly flow: FlowState | null
  readonly onAnswer: (prompt: PromptEvent, value: string) => void
  readonly onClose: () => void
  readonly onRetry: () => void
}) {
  const outcome = flow?.outcome ?? null
  const footer =
    outcome === null ? (
      <div className="models-login__footer">
        <Button onClick={onClose} size="sm" type="button" variant="ghost">
          取消
        </Button>
      </div>
    ) : outcome.ok ? (
      <div className="models-login__footer">
        <Button onClick={onClose} size="sm" type="button">
          完成
        </Button>
      </div>
    ) : (
      <div className="models-login__footer">
        <Button onClick={onClose} size="sm" type="button" variant="ghost">
          关闭
        </Button>
        <Button onClick={onRetry} size="sm" type="button">
          重试
        </Button>
      </div>
    )
  return (
    <Dialog
      className="models-login-dialog"
      closeOnOverlayClick={false}
      footer={footer}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      open={flow !== null}
      title={flow === null ? '登录' : `登录 ${flow.entry.name}`}
    >
      {flow === null ? null : <LoginBody flow={flow} onAnswer={onAnswer} />}
    </Dialog>
  )
}

function LoginBody({
  flow,
  onAnswer,
}: {
  readonly flow: FlowState
  readonly onAnswer: (p: PromptEvent, v: string) => void
}) {
  if (flow.outcome !== null) return <Outcome outcome={flow.outcome} />
  const { prompt, auth, fallback } = flow
  if (prompt !== null) {
    return (
      <div className="models-login">
        <PromptForm key={prompt.promptId} onSubmit={(value) => onAnswer(prompt, value)} prompt={prompt} />
      </div>
    )
  }
  if (auth === null) {
    return (
      <div className="models-login">
        <Waiting text={flow.progress ?? '正在打开授权页…'} />
      </div>
    )
  }
  if (auth.code !== null) {
    return (
      <div className="models-login">
        <Waiting text={flow.progress ?? '等待在网页上确认…'} />
        <p className="models-login__hint">在打开的网页中输入下面的验证码。</p>
        <DeviceCode code={auth.code} />
        <div className="models-login__links">
          <Button
            className="models-login__btn"
            onClick={() => window.open(auth.url, '_blank', 'noopener')}
            size="xs"
            type="button"
            variant="soft"
          >
            <ExternalLink aria-hidden="true" />
            打开网页
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="models-login">
      <Waiting text={flow.progress ?? '等待在浏览器中完成授权…'} />
      <p className="models-login__hint">{auth.instructions ?? '授权页已在浏览器中打开，完成后这里会自动继续。'}</p>
      <AuthLinks url={auth.url} />
      {fallback === null ? null : (
        <ManualCode key={fallback.promptId} onSubmit={(value) => onAnswer(fallback, value)} prompt={fallback} />
      )}
    </div>
  )
}

function Outcome({ outcome }: { readonly outcome: NonNullable<FlowState['outcome']> }) {
  if (!outcome.ok) {
    return (
      <div className="models-login">
        <p className="models-login__status" data-tone="danger">
          <CircleAlert aria-hidden="true" />
          登录失败
        </p>
        <p className="models-login__detail">{outcome.message}</p>
      </div>
    )
  }
  return (
    <div className="models-login">
      <p className="models-login__status" data-tone="success">
        <CircleCheck aria-hidden="true" />
        {outcome.key ? '已获取 API Key' : '登录成功'}
      </p>
      {outcome.account === null ? null : <p className="models-login__hint">已登录为 {outcome.account}</p>}
    </div>
  )
}

function Waiting({ text }: { readonly text: string }) {
  return (
    <p className="models-login__waiting" role="status">
      <InlineSpinner />
      {text}
    </p>
  )
}

function AuthLinks({ url }: { readonly url: string }) {
  const { copied, copy } = useCopy()
  return (
    <div className="models-login__links">
      <Button
        className="models-login__btn"
        onClick={() => window.open(url, '_blank', 'noopener')}
        size="xs"
        type="button"
        variant="soft"
      >
        <ExternalLink aria-hidden="true" />
        重新打开
      </Button>
      <Button className="models-login__btn" onClick={() => copy(url)} size="xs" type="button" variant="ghost">
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? '已复制' : '复制链接'}
      </Button>
    </div>
  )
}

function DeviceCode({ code }: { readonly code: string }) {
  const { copied, copy } = useCopy()
  return (
    <div className="models-login__code">
      <span>{code}</span>
      <Button
        aria-label="复制验证码"
        className="models-login__btn"
        onClick={() => copy(code)}
        size="xs"
        type="button"
        variant="ghost"
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? '已复制' : '复制'}
      </Button>
    </div>
  )
}

function PromptForm({
  prompt,
  onSubmit,
}: {
  readonly prompt: PromptEvent
  readonly onSubmit: (value: string) => void
}) {
  const [value, setValue] = useState('')
  const blocked = value.trim() === '' && !prompt.allowEmpty
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!blocked) onSubmit(value.trim())
  }
  return (
    <form className="models-login__form" onSubmit={submit}>
      <label className="models-login__label" htmlFor="models-login-input">
        {prompt.message}
      </label>
      <div className="models-login__row">
        <input
          autoComplete="off"
          className="settings-input"
          id="models-login-input"
          onChange={(event) => setValue(event.target.value)}
          placeholder={prompt.placeholder ?? undefined}
          ref={focusOnMount}
          type={prompt.secret ? 'password' : 'text'}
          value={value}
        />
        <Button disabled={blocked} size="sm" type="submit">
          继续
        </Button>
      </div>
    </form>
  )
}

/* 备用通道收起来：多数时候浏览器会自己跳回，这一格只是兜底 */
function ManualCode({
  prompt,
  onSubmit,
}: {
  readonly prompt: PromptEvent
  readonly onSubmit: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  if (!open) {
    return (
      <button className="models-login__toggle" onClick={() => setOpen(true)} type="button">
        浏览器没有自动跳回？
      </button>
    )
  }
  return (
    <form
      className="models-login__form models-login__form--manual"
      onSubmit={(event) => {
        event.preventDefault()
        if (value.trim() !== '') onSubmit(value.trim())
      }}
    >
      <label className="models-login__label" htmlFor="models-login-manual">
        {prompt.message}
      </label>
      <div className="models-login__row">
        <input
          autoComplete="off"
          className="settings-input"
          id="models-login-manual"
          onChange={(event) => setValue(event.target.value)}
          ref={focusOnMount}
          type={prompt.secret ? 'password' : 'text'}
          value={value}
        />
        <Button disabled={value.trim() === ''} size="sm" type="submit">
          继续
        </Button>
      </div>
    </form>
  )
}
