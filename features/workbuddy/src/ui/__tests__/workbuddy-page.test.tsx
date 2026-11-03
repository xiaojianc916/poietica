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
    /* 四个动作只画图标：可访问名与悬停提示仍是原来那四个词。 */
    expect(screen.getByRole('button', { name: '首选' })).toBeDefined()
    expect(screen.getByRole('button', { name: '重新登录' })).toBeDefined()
    expect(screen.getByRole('button', { name: '签到' })).toBeDefined()
    const removeButton = screen.getByRole('button', { name: '移除' })
    expect(removeButton).toBeDefined()
    /* 删除键静息时不是 dangerSoft 的常驻红底：红色只在悬停 / 聚焦时加。 */
    expect(removeButton.classList.contains('ui-button--danger-soft')).toBe(false)
    expect(removeButton.classList.contains('workbuddy-account__action--danger')).toBe(true)
    /* 首选与签到都已处于完成态：不可再点，但悬停提示仍要能出现（所以是 aria-disabled，不设原生 disabled）。 */
    expect(screen.getByRole('button', { name: '首选' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: '首选' }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText('设为首选')).toBeNull()
    expect(screen.queryByText('重新登录')).toBeNull()
    expect(screen.queryByText('今日已签到')).toBeNull()
    expect(screen.getByText('已注册为模型服务商')).toBeDefined()
  })

  test('Credits 与 Extra credits 合成一条，且不再列出不扣积分的模型', async () => {
    const merged = {
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
                    used: 5,
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
                    runsOut: 12.25,
                    notModels: ['e', 'f'],
                  },
                ],
              },
      })),
    }
    render(<WorkBuddyPage api={apiOf({ snapshot: async () => merged })} openUrl={async () => undefined} />)

    expect(await screen.findByText('Credits · 166.78 / 180.13')).toBeDefined()
    expect(screen.queryByText(/Extra credits/)).toBeNull()
    expect(screen.getAllByRole('progressbar')).toHaveLength(1)
    expect(screen.getByRole('progressbar', { name: 'Credits 剩余 93%' })).toBeDefined()
    expect(screen.getByText('88.5 积分即将到期')).toBeDefined()
    expect(screen.queryByText('12.25 积分即将到期')).toBeNull()
    // 免费模型那一条整块删掉：标题与展开后的模型名都不再上屏。
    expect(screen.queryByText('这些模型不扣这一格积分')).toBeNull()
    expect(screen.queryByText('a、b、c 等 1 个')).toBeNull()
    // 两格合成一条后不再挂任何「不拦账号 / 不影响继续使用」的说明。
    expect(screen.queryByText(/不拦账号/)).toBeNull()
    expect(screen.queryByText(/不影响继续使用/)).toBeNull()
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
