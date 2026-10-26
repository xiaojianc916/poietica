import { afterEach, describe, expect, test } from 'bun:test'
import { createTestLogger } from '@poietica/test-kit'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TerminalInfo } from '../../contract'
import type { TerminalApi } from '../api'
import { createLazyTerminalRuntime, type LazyTerminalRuntime } from '../terminal-loader'
import { TerminalPanel } from '../terminal-panel'
import * as storeModule from '../terminal-store'

/* 多终端（R-49）：每条终端是**右坞标签条**上的一格（见 terminal-dock-tabs.test.tsx），面板里不再套第二条标签条，只画选中那条的画面。
 * 面板也不再「打开就先开一条」：新建只来自用户的动作（启动器 / 加号 / 快捷键 / 空态里的按钮）。xterm 的渲染本身不在 happy-dom 里
 * 断言，这里只验 DOM 形状。 */

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
      return { data: '', endOffset: 0 }
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

async function makeRuntime(api: TerminalApi): Promise<LazyTerminalRuntime> {
  const runtime = createLazyTerminalRuntime({
    api,
    logger: createTestLogger(),
    cwd: () => 'C:\\work',
    openExternal: () => undefined,
    onError: () => undefined,
    loadModule: async () => storeModule,
  })
  await runtime.load()
  return runtime
}

const views = (container: HTMLElement) => [...container.querySelectorAll('[data-terminal-panel] > div > div')]

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('terminal 面板（R-49 多终端）', () => {
  test('没有终端：只画空态与「新建终端」，不替用户开 PTY；点了才开', async () => {
    const runtime = await makeRuntime(fakeApi())

    render(<TerminalPanel runtime={runtime} />)

    expect(runtime.count()).toBe(0)
    expect(screen.getByText('没有打开的终端')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '新建终端' }))
    expect(runtime.count()).toBe(1)
    expect(screen.queryByText('没有打开的终端')).toBeNull()
    runtime.dispose()
  })

  test('面板里不再有第二条标签条：几条终端都只有画面，没有 tab 与加号', async () => {
    const runtime = await makeRuntime(fakeApi())
    runtime.create()
    runtime.create()

    render(<TerminalPanel runtime={runtime} />)

    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '新建终端' })).toBeNull()
    runtime.dispose()
  })

  test('每条终端一块画面；换选中只换活动项，画面块数不变', async () => {
    const runtime = await makeRuntime(fakeApi())
    runtime.create()
    runtime.create()
    const [a] = runtime.snapshot().terminals.map((t) => t.id)

    const { container } = render(<TerminalPanel runtime={runtime} />)

    expect(views(container)).toHaveLength(2)

    runtime.select(a!)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(views(container)).toHaveLength(2)
    expect(runtime.snapshot().activeId).toBe(a!)
    runtime.dispose()
  })

  test('关掉一条：画面跟着少一块，Host 侧 PTY 也关掉', async () => {
    const api = fakeApi()
    const runtime = await makeRuntime(api)

    api.restored = [info('t4'), info('t5')]
    await runtime.restore()
    const { container } = render(<TerminalPanel runtime={runtime} />)
    expect(views(container)).toHaveLength(2)

    runtime.close(runtime.snapshot().terminals[0]!.id)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(views(container)).toHaveLength(1)
    expect(api.closed).toEqual(['t4'])
    runtime.dispose()
  })
})
