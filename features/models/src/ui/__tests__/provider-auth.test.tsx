import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { LoginEvent, LoginProvider } from '../../contract'
import type { ModelsApi } from '../api'
import { type ProviderAuthProps, useProviderAuth } from '../provider-auth'

/*
 * U-2：认证跟着服务商走。支持账号登录的那几家有「账号登录 | API Key」切换；登录走一个对话框，
 * 浏览器回调的备用输入收起来；只收 API Key 的就只有一格 Key。
 */

const entry = (provider: string, extra: Partial<LoginProvider> = {}): LoginProvider => ({
  id: provider,
  name: provider,
  provider,
  available: true,
  authenticated: false,
  account: null,
  issuesApiKey: false,
  ...extra,
})

function fakeApi(logins: LoginProvider[]) {
  const loginListeners = new Set<(p: { loginId: string; event: LoginEvent }) => void>()
  const calls = {
    setApiKey: mock(async (_provider: string, _key: string) => undefined),
    clearApiKey: mock(async (_provider: string) => undefined),
    logout: mock(async (_provider: string) => undefined),
    startLogin: mock(async (_id: string) => 'login-1'),
    answerLogin: mock(async (_loginId: string, _promptId: string, _value: string) => undefined),
    cancelLogin: mock(async (_loginId: string) => undefined),
  }
  const api = {
    ...calls,
    loginProviders: async () => logins,
    onChanged: () => ({ dispose: () => undefined }),
    onLoginEvent: (listener: (p: { loginId: string; event: LoginEvent }) => void) => {
      loginListeners.add(listener)
      return { dispose: () => loginListeners.delete(listener) }
    },
  } as unknown as ModelsApi
  const emit = (event: LoginEvent) => {
    act(() => {
      for (const listener of loginListeners) listener({ loginId: 'login-1', event })
    })
  }
  return { api, calls, emit }
}

function Harness({ api, ...props }: ProviderAuthProps & { readonly api: ModelsApi }) {
  const auth = useProviderAuth(api)
  return (
    <>
      {auth.slot.render(props)}
      {auth.dialog}
    </>
  )
}

/* 授权页交给系统浏览器：测试里只记下要打开哪一页，不真去拉网页 */
let opened: string[] = []
beforeEach(() => {
  opened = []
  window.open = ((url?: string | URL) => {
    opened.push(String(url))
    return null
  }) as typeof window.open
})
afterEach(() => {
  cleanup()
})

describe('ProviderAuth', () => {
  test('已登录：显示账号；退出登录只退账号（按凭据记在的 provider）', async () => {
    const { api, calls } = fakeApi([entry('openai-codex', { authenticated: true, account: 'me@example.com' })])
    render(<Harness api={api} configured providerId="openai-codex" />)
    await screen.findByText('me@example.com')
    expect(screen.getByText('已登录')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    await waitFor(() => expect(calls.logout).toHaveBeenCalledWith('openai-codex'))
    expect(calls.clearApiKey).not.toHaveBeenCalled()
  })

  test('没登录也没 Key：默认停在账号登录；对话框给出设备码，完成后报成功并回调', async () => {
    const { api, calls, emit } = fakeApi([entry('github-copilot', { name: 'GitHub Copilot' })])
    const authorized = mock(() => undefined)
    render(<Harness api={api} configured={false} onAuthorized={authorized} providerId="github-copilot" />)
    fireEvent.click(await screen.findByRole('button', { name: '登录' }))
    await waitFor(() => expect(calls.startLogin).toHaveBeenCalledWith('github-copilot'))
    expect(await screen.findByText('登录 GitHub Copilot')).toBeTruthy()
    emit({
      kind: 'auth',
      url: 'https://github.com/login/device',
      launchUrl: null,
      code: 'ABCD-1234',
      instructions: null,
    })
    expect(screen.getByText('ABCD-1234')).toBeTruthy()
    expect(opened).toEqual(['https://github.com/login/device'])
    emit({ kind: 'done', identity: { kind: 'oauth', email: 'me@example.com', orgName: null } })
    expect(screen.getByText('登录成功')).toBeTruthy()
    expect(screen.getByText('已登录为 me@example.com')).toBeTruthy()
    expect(authorized).toHaveBeenCalledTimes(1)
  })

  test('浏览器回调的备用输入默认收起；展开后交回的是那一格的 promptId', async () => {
    const { api, calls, emit } = fakeApi([entry('anthropic')])
    render(<Harness api={api} configured={false} providerId="anthropic" />)
    fireEvent.click(await screen.findByRole('button', { name: '登录' }))
    await waitFor(() => expect(calls.startLogin).toHaveBeenCalled())
    await act(async () => undefined)
    emit({ kind: 'auth', url: 'https://claude.ai/oauth', launchUrl: null, code: null, instructions: null })
    emit({
      kind: 'prompt',
      promptId: 'p-fallback',
      message: '粘贴授权码或完整的回调地址',
      placeholder: null,
      secret: false,
      allowEmpty: false,
      fallback: true,
    })
    expect(screen.queryByLabelText('粘贴授权码或完整的回调地址')).toBeNull()
    fireEvent.click(screen.getByText('浏览器没有自动跳回？'))
    fireEvent.change(screen.getByLabelText('粘贴授权码或完整的回调地址'), { target: { value: 'code#state' } })
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(calls.answerLogin).toHaveBeenCalledWith('login-1', 'p-fallback', 'code#state')
  })

  test('交回那一格失败（这次登录已经结束）：对话框报失败与原因，不静默停在等待', async () => {
    const { api, calls, emit } = fakeApi([entry('anthropic')])
    calls.answerLogin.mockImplementation(async () => {
      throw new Error('这次登录已经结束或不存在')
    })
    render(<Harness api={api} configured={false} providerId="anthropic" />)
    fireEvent.click(await screen.findByRole('button', { name: '登录' }))
    await waitFor(() => expect(calls.startLogin).toHaveBeenCalled())
    await act(async () => undefined)
    emit({ kind: 'auth', url: 'https://claude.ai/oauth', launchUrl: null, code: null, instructions: null })
    emit({
      kind: 'prompt',
      promptId: 'p-fallback',
      message: '粘贴授权码或完整的回调地址',
      placeholder: null,
      secret: false,
      allowEmpty: false,
      fallback: true,
    })
    fireEvent.click(screen.getByText('浏览器没有自动跳回？'))
    fireEvent.change(screen.getByLabelText('粘贴授权码或完整的回调地址'), { target: { value: 'code#state' } })
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(await screen.findByText('登录失败')).toBeTruthy()
    expect(screen.getByText('这次登录已经结束或不存在')).toBeTruthy()
  })

  test('关掉进行中的登录 = 取消', async () => {
    const { api, calls } = fakeApi([entry('anthropic')])
    render(<Harness api={api} configured={false} providerId="anthropic" />)
    fireEvent.click(await screen.findByRole('button', { name: '登录' }))
    await waitFor(() => expect(calls.startLogin).toHaveBeenCalled())
    await act(async () => undefined)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(calls.cancelLogin).toHaveBeenCalledWith('login-1')
  })

  test('只收 API Key 的服务商：没有切换，存 Key 后回调', async () => {
    const { api, calls } = fakeApi([])
    const authorized = mock(() => undefined)
    render(<Harness api={api} configured={false} onAuthorized={authorized} providerId="deepseek" submitLabel="添加" />)
    expect(screen.queryByText('账号登录')).toBeNull()
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: ' sk-test ' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(authorized).toHaveBeenCalledTimes(1))
    expect(calls.setApiKey).toHaveBeenCalledWith('deepseek', 'sk-test')
  })

  test('浏览器换 Key 的服务商（OpenRouter）：仍是 API Key，另给一条在浏览器中获取', async () => {
    const { api, calls } = fakeApi([entry('openrouter', { issuesApiKey: true })])
    render(<Harness api={api} configured={false} providerId="openrouter" />)
    const fetch = await screen.findByText('没有 Key？在浏览器中登录获取')
    expect(screen.queryByText('账号登录')).toBeNull()
    fireEvent.click(fetch)
    await waitFor(() => expect(calls.startLogin).toHaveBeenCalledWith('openrouter'))
  })

  test('已存 Key 且没登录账号：默认停在 API Key，可移除', async () => {
    const { api, calls } = fakeApi([entry('anthropic')])
    render(<Harness api={api} configured providerId="anthropic" />)
    expect(await screen.findByPlaceholderText('已保存，输入新的 Key 以替换')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    await waitFor(() => expect(calls.clearApiKey).toHaveBeenCalledWith('anthropic'))
  })
})
