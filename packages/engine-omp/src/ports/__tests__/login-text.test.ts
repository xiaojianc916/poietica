import '../../__tests__/omp-home'

import { describe, expect, test } from 'bun:test'
import { getProviderDefinition } from '@oh-my-pi/pi-ai/registry'
import { loginAuthText, loginProgressText, loginPromptText } from '../login-text'
import { loginKindOf } from '../omp-ports'

/* 界面上不出现 omp 的英文原文：认得的换中文，进度认不得就不转发，输入提示认不得原样交回（总得让人知道填什么）。 */
describe('login-text', () => {
  test('进度：认得的换成中文，带次数的保留数字，认不得的返回 null', () => {
    expect(loginProgressText('Waiting for browser authentication...')).toBe('等待在浏览器中完成授权…')
    expect(loginProgressText('Exchanging authorization code for tokens...')).toBe('正在完成登录…')
    expect(loginProgressText('Waiting for project provisioning (attempt 2/10)...')).toBe(
      '正在等待项目开通（第 2/10 次）…',
    )
    expect(loginProgressText('Something omp just started saying')).toBeNull()
  })

  test('输入提示：omp 挂的「粘贴授权码」备用格标成 fallback；认不得的原样交回', () => {
    expect(loginPromptText('Paste the authorization code (or full redirect URL):', null)).toEqual({
      message: '粘贴授权码或完整的回调地址',
      placeholder: null,
      fallback: true,
    })
    expect(loginPromptText('Organization slug', 'acme')).toEqual({
      message: 'Organization slug',
      placeholder: 'acme',
      fallback: false,
    })
  })

  test('授权说明：设备码单独拎出来，其余认得的换成中文', () => {
    expect(loginAuthText('Enter code: ABCD-1234')).toEqual({ code: 'ABCD-1234', instructions: null })
    expect(loginAuthText(null)).toEqual({ code: null, instructions: null })
    expect(loginAuthText('Sign in to Snowflake in your browser and approve access.')).toEqual({
      code: null,
      instructions: '在浏览器中登录 Snowflake 并批准访问。',
    })
  })
})

/* 照 omp 真身的登录名单分类：订阅类是账号授权，OpenRouter 这类浏览器换钥匙，其余几十家只是贴 API Key。 */
describe('loginKindOf', () => {
  test('omp 名单里的典型几家分到对的类', () => {
    const kind = (id: string) => loginKindOf(getProviderDefinition(id) as Parameters<typeof loginKindOf>[0])
    expect(kind('anthropic')).toBe('account')
    expect(kind('openai-codex')).toBe('account')
    expect(kind('github-copilot')).toBe('account')
    expect(kind('openrouter')).toBe('browser-key')
    expect(kind('zai')).toBe('manual-key')
    expect(loginKindOf(undefined)).toBe('account')
  })
})
