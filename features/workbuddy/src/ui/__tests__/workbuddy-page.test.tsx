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
            amount: 12,
            limit: 160,
            balance: null,
            unit: 'credits',
            display: '12 / 160',
            resetsAt: '2026-11-03T00:00:00.000Z',
            runsOutAt: null,
            span: null,
            models: null,
            refused: false,
          },
        ],
        signIn: 'kept',
        error: null,
      },
      usageAt: 1,
      checkedInToday: false,
      checkin: null,
      createdAt: 1,
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
    expect(screen.getByText(/12 \/ 160/)).toBeDefined()
    expect(screen.getByText('首选')).toBeDefined()
    expect(screen.getByText('已注册为模型服务商')).toBeDefined()
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
