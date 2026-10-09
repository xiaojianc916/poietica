import { afterEach, describe, expect, test } from 'bun:test'
import { createTestLogger } from '@poietica/test-kit'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TerminalInfo } from '../../contract'
import type { TerminalApi } from '../api'
import { TerminalPanel } from '../terminal-panel'
import { createTerminalRuntime } from '../terminal-store'

/*
 * 面板这一层的形状（07 页 §11E 的标签条 + 外观以 legacy 为准的两条）：
 *   - 打开这一格没有终端时**先开一条**（legacy 的 TerminalPane 挂载即 attach）；
 *   - 只有一条终端时**不画标签条**（legacy 每格只有一条终端，那一行不存在）；
 *   - 从第二条起画标签条：每个终端一个标签、`+` 新建、标签上的 `×` 关闭、
 *     点击标签把它切到前台。
 * xterm 的渲染本身不在 happy-dom 里断言（14 页 §0.4 的口径），这里只验 DOM 形状。
 */

const info = (terminalId: string, over: Partial<TerminalInfo> = {}): TerminalInfo => ({
  terminalId,
  cwd: 'C:\\work',
  shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  title: 'pwsh',
  exited: false,
  exitCode: null,
  ...over,
})

function fakeApi(): TerminalApi & { readonly closed: string[]; restored: readonly TerminalInfo[] } {
  const closed: string[] = []
  const api = {
    closed,
    restored: [] as readonly TerminalInfo[],
    async open() {
      return info('t1')
    },
    async write() {
      return undefined
    },
    async resize() {
      return undefined
    },
    async close(terminalId: string) {
      closed.push(terminalId)
    },
    async list() {
      return api.restored
    },
    async replay() {
      return ''
    },
    onOutput() {
      return { dispose: () => undefined }
    },
    onExited() {
      return { dispose: () => undefined }
    },
  }
  return api
}

function makeRuntime(api: TerminalApi) {
  return createTerminalRuntime({
    api,
    logger: createTestLogger(),
    cwd: () => 'C:\\work',
    openExternal: () => undefined,
    onError: () => undefined,
  })
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('terminal 面板（07 页 §11E 的标签条）', () => {
  test('打开这一格没有终端时先开一条（legacy 的挂载即 attach）', () => {
    const runtime = makeRuntime(fakeApi())

    render(<TerminalPanel runtime={runtime} />)

    expect(runtime.count()).toBe(1)
    /* 只有一条：没有那一行标签条，也没有加号（legacy 的每格一条终端就是这个样子）。 */
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '新建终端' })).toBeNull()
  })

  test('已有终端时不再自动新建（重挂载不会多开 PTY）', () => {
    const runtime = makeRuntime(fakeApi())
    const created = runtime.create()

    render(<TerminalPanel runtime={runtime} />)

    expect(runtime.count()).toBe(1)
    expect(runtime.store.getState().activeId).toBe(created)
  })

  test('开出第二条起画标签条：每条一个标签，`+` 再新建', () => {
    const runtime = makeRuntime(fakeApi())

    /* 先备好两条（第一条由挂载时自动开、第二条走 store），再挂载：这时才该有标签条。 */
    runtime.create()
    runtime.create()
    render(<TerminalPanel runtime={runtime} />)

    expect(screen.getAllByRole('tab')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: '新建终端' }))
    expect(runtime.count()).toBe(3)
  })

  test('点击标签切换活动项', () => {
    const runtime = makeRuntime(fakeApi())
    const first = runtime.create()
    const second = runtime.create()

    runtime.select(first)
    render(<TerminalPanel runtime={runtime} />)

    const secondTab = screen.getAllByRole('tab')[1]!

    fireEvent.click(secondTab)
    expect(runtime.store.getState().activeId).toBe(second)
    expect(secondTab.getAttribute('aria-selected')).toBe('true')
  })

  test('`×` 关闭对应标签（并通知 Host）', async () => {
    const api = fakeApi()
    const runtime = makeRuntime(api)

    api.restored = [info('t4'), info('t5')]
    await runtime.restore()
    render(<TerminalPanel runtime={runtime} />)

    fireEvent.click(screen.getAllByTitle('关闭终端')[0]!)

    expect(runtime.count()).toBe(1)
    expect(api.closed).toEqual(['t4'])
  })

  test('已退出的标签显示状态并变灰', async () => {
    const api = fakeApi()
    const runtime = makeRuntime(api)

    api.restored = [info('t6'), info('t7', { exited: true, exitCode: 0 })]
    await runtime.restore()
    render(<TerminalPanel runtime={runtime} />)

    const tabs = screen.getAllByRole('tab')
    expect(tabs[1]!.textContent).toContain('已退出 (0)')
    expect(tabs[1]!.className).toContain('opacity-60')
  })
})
