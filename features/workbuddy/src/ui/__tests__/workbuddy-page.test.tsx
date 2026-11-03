import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { WorkBuddyCheckin, WorkBuddySnapshot } from '../../contract'
import type { WorkBuddyApi } from '../api'
import { WorkBuddyPage } from '../workbuddy-page'

const SNAPSHOT: WorkBuddySnapshot = {
  accounts: [
    {
      id: 'a1',
      label: '稻黄草',
      uid: 'u1',
      kind: 'browser',
      plan: 'Free plan',
      preferred: true,
      status: 'ok',
      statusMessage: null,
      usage: {
        plan: 'Free plan',
        windows: [
          {
            name: 'Credits',
            used: 7.5,
            amount: 12.345,
            limit: 160.129,
            balance: null,
            unit: 'credits',
            display: '12 / 160',
            resetsAt: '2026-11-03T00:00:00.000Z',
            runsOutAt: null,
            span: null,
            models: null,
            refused: false,
            aside: false,
            runsOut: null,
            notModels: null,
          },
        ],
        signIn: 'kept',
        error: null,
      },
      usageAt: 1,
      checkedInToday: false,
      checkin: null,
      createdAt: 1,
      restUntil: 0,
      restReason: null,
    },
  ],
  proxy: {
    enabled: true,
    running: true,
    port: 12345,
    endpoint: 'http://127.0.0.1:12345/p/••••/v1',
    providerId: 'workbuddy',
    providerState: 'registered',
    providerMessage: null,
  },
  autoCheckin: true,
}

function apiOf(overrides: Partial<WorkBuddyApi> = {}): WorkBuddyApi {
  return {
    snapshot: async () => SNAPSHOT,
    startBrowserLogin: async () => ({ loginId: 'l1', url: 'https://example.test', instructions: '登录' }),
    cancelLogin: async () => undefined,
    removeAccount: async () => undefined,
    setPreferred: async () => undefined,
    refreshUsage: async () => SNAPSHOT,
    checkin: async () => ({ at: 1, day: '2026-11-01', outcome: 'claimed', credit: 5, streak: 2, message: null }),
    setEnabled: async () => SNAPSHOT,
    setAutoCheckin: async () => SNAPSHOT,
    repairProvider: async () => SNAPSHOT,
    onChanged: () => ({ dispose: () => undefined }),
    onLoginEvent: () => ({ dispose: () => undefined }),
    ...overrides,
  }
}

afterEach(cleanup)

describe('WorkBuddy 设置页', () => {
  test('画出账号、套餐、积分和首选标记', async () => {
    render(<WorkBuddyPage api={apiOf()} openUrl={async () => undefined} />)
    expect(await screen.findByText('稻黄草')).toBeDefined()
    expect(screen.getByText('Free plan')).toBeDefined()
    expect(screen.getByText('Credits · 147.78 / 160.13')).toBeDefined()
    expect(screen.queryByText(/重置/)).toBeNull()
    expect(screen.getByRole('progressbar', { name: 'Credits 剩余 92%' })).toBeDefined()
    expect(screen.getByText('首选')).toBeDefined()
    expect(screen.getByText('已注册为模型服务商')).toBeDefined()
  })

  test('摆着看的那一格画得弱、说明不拦账号，并标出即将到期的积分', async () => {
    const aside = {
      ...SNAPSHOT,
      accounts: SNAPSHOT.accounts.map((account) => ({
        ...account,
        usage:
          account.usage === null
            ? null
            : {
                ...account.usage,
                windows: [
                  ...account.usage.windows.map((window) => ({
                    ...window,
                    runsOut: 88.5,
                    notModels: ['a', 'b', 'c', 'd'],
                  })),
                  {
                    name: 'Extra credits',
                    used: 1,
                    amount: 1,
                    limit: 20,
                    balance: null,
                    unit: 'credits',
                    display: '1 / 20',
                    resetsAt: null,
                    runsOutAt: null,
                    span: null,
                    models: null,
                    refused: false,
                    aside: true,
                    runsOut: null,
                    notModels: null,
                  },
                ],
              },
      })),
    }
    render(<WorkBuddyPage api={apiOf({ snapshot: async () => aside })} openUrl={async () => undefined} />)

    expect(await screen.findByText('88.5 积分即将到期')).toBeDefined()
    expect(screen.getAllByText('这些模型不扣这一格积分')).toHaveLength(1)
    expect(screen.getByText('a、b、c 等 1 个')).toBeDefined()
    // 只有 aside 的那一格才说「不拦账号」。
    expect(screen.getAllByText(/这一格不拦账号/)).toHaveLength(1)
    expect(
      screen.getByText('Extra credits · 19 / 20').closest('.workbuddy-credit')?.getAttribute('data-aside'),
    ).toEqual('true')
    // 决定账号停不停的那一格不该被标成摆着看的。
    expect(
      screen.getByText('Credits · 147.78 / 160.13').closest('.workbuddy-credit')?.getAttribute('data-aside'),
    ).toBeNull()
  })

  test('签到按钮把账号交给 Core', async () => {
    const checkin = mock(async (): Promise<WorkBuddyCheckin> => ({
      at: 1,
      day: '2026-11-01',
      outcome: 'claimed',
      credit: 5,
      streak: 2,
      message: null,
    }))
    render(<WorkBuddyPage api={apiOf({ checkin })} openUrl={async () => undefined} />)
    fireEvent.click(await screen.findByRole('button', { name: '签到' }))
    await waitFor(() => expect(checkin).toHaveBeenCalledWith('a1'))
  })

  test('添加账号直接发起浏览器登录并自动打开授权页', async () => {
    const openUrl = mock(async () => undefined)
    const startBrowserLogin = mock(async () => ({ loginId: 'l1', url: 'https://example.test', instructions: '登录' }))
    render(<WorkBuddyPage api={apiOf({ startBrowserLogin })} openUrl={openUrl} />)
    fireEvent.click(await screen.findByRole('button', { name: /添加 WorkBuddy 账号/ }))
    await waitFor(() => expect(startBrowserLogin).toHaveBeenCalledWith(null))
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://example.test'))
    expect(await screen.findByText(/已请求系统浏览器打开/)).toBeDefined()
    expect(screen.getByRole('button', { name: '复制链接' })).toBeDefined()
  })

  test('冲突提示只出现一次：warning 有它，description 就不再复述', async () => {
    const message = '模型服务商 workbuddy 已存在；请先在「模型」里移除它，再点重新注册'
    render(
      <WorkBuddyPage
        api={apiOf({
          snapshot: async () => ({
            ...SNAPSHOT,
            proxy: { ...SNAPSHOT.proxy, providerState: 'conflict', providerMessage: message },
          }),
        })}
        openUrl={async () => undefined}
      />,
    )
    expect(await screen.findAllByText(message)).toHaveLength(1)
    /* 有账号、反代开着、又不在 registered：要能一键重新注册 */
    expect(screen.getByRole('button', { name: '重新注册' })).toBeDefined()
  })

  test('没有账号时给添加入口', async () => {
    render(
      <WorkBuddyPage
        api={apiOf({
          snapshot: async () => ({ ...SNAPSHOT, accounts: [] }),
        })}

        openUrl={async () => undefined}
      />,
    )
    expect(await screen.findByText(/还没有 WorkBuddy 账号/)).toBeDefined()
    expect(screen.getByRole('button', { name: /添加 WorkBuddy 账号/ })).toBeDefined()
  })
})
