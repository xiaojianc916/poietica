import { afterEach, describe, expect, test } from 'bun:test'
import { createTestLogger } from '@poietica/test-kit'
import type { DockPaneSet, LayoutService } from '@poietica/ui-kernel'
import { cleanup } from '@testing-library/react'
import type { TerminalInfo } from '../../contract'
import type { TerminalApi } from '../api'
import { createTerminalDockTabs, releaseTerminalDock, watchLastTerminal } from '../terminal-dock-tabs'
import { createLazyTerminalRuntime } from '../terminal-loader'
import * as storeModule from '../terminal-store'

/* R-49：每条终端是右坞标签条上的一格。钉三件事 —— 标签跟着终端表走（加载前排队的那一格也算）、选中 / 关闭 / 新开回到终端自己的动作、
 * 最后一条没了时坞不停在一块空的终端面上。 */

const PANEL = 'terminal.panel'

const info = (terminalId: string, over: Partial<TerminalInfo> = {}): TerminalInfo => ({
  terminalId,
  cwd: 'C:\\work',
  shell: 'pwsh.exe',
  title: 'pwsh',
  exited: false,
  exitCode: null,
  ...over,
})

function fakeApi(restored: readonly TerminalInfo[] = []): TerminalApi & { readonly closed: string[] } {
  const closed: string[] = []
  return {
    closed,
    open: async () => info('t1'),
    write: async () => undefined,
    resize: async () => undefined,
    close: async (terminalId) => {
      closed.push(terminalId)
    },
    list: async () => restored,
    replay: async () => ({ data: '', endOffset: 0 }),
    onOutput: () => ({ dispose: () => undefined }),
    onExited: () => ({ dispose: () => undefined }),
  }
}

function runtimeOf(api: TerminalApi, loadModule: () => Promise<typeof storeModule> = async () => storeModule) {
  return createLazyTerminalRuntime({
    api,
    logger: createTestLogger(),
    cwd: () => null,
    openExternal: () => undefined,
    onError: () => undefined,
    loadModule,
  })
}

/** 只记 terminal 用到的那几个动作；panes 用真实形状，closePane / focusPane 按 LayoutService 的语义改账。 */
function fakeLayout(byOwner: Record<string, DockPaneSet> = {}) {
  const calls: string[] = []
  let panes = { byOwner }
  const layout = {
    panes: { current: () => panes },
    openPanel: (_location: 'right', id: string) => {
      calls.push(`openPanel:${id}`)
    },
    closePane: (owner: string, id: string) => {
      calls.push(`closePane:${owner}:${id}`)
      const set = panes.byOwner[owner]!
      const ids = set.ids.filter((x) => x !== id)
      panes = {
        byOwner: {
          ...panes.byOwner,
          [owner]: { ...set, ids, activeId: set.activeId === id ? (ids.at(-1) ?? null) : set.activeId },
        },
      }
    },
    focusPane: (owner: string, id: string) => {
      calls.push(`focusPane:${owner}:${id}`)
    },
  } as unknown as LayoutService
  return { layout, calls, panes: () => panes }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  cleanup()
})

describe('终端的右坞标签（R-49）', () => {
  test('加载前新开：标签立刻上条（标题「终端」、选中），加载完同一格还在', async () => {
    const runtime = runtimeOf(fakeApi())
    const { layout, calls } = fakeLayout()
    const tabs = createTerminalDockTabs({ layout, panelId: PANEL, runtime })

    tabs.onOpen()
    expect(tabs.tabs().map((t) => [t.title, t.active])).toEqual([['终端', true]])
    expect(calls).toEqual([`openPanel:${PANEL}`])

    const id = tabs.tabs()[0]!.id
    await tick()
    expect(tabs.tabs().map((t) => t.id)).toEqual([id])
    runtime.dispose()
  })

  test('标题跟着 Host 给的信息走：shell 名 • 序号；退出后写退出码', async () => {
    const runtime = runtimeOf(fakeApi([info('t3'), info('t4', { exited: true, exitCode: 1 })]))
    const tabs = createTerminalDockTabs({ layout: fakeLayout().layout, panelId: PANEL, runtime })

    await runtime.restore()
    expect(tabs.tabs().map((t) => t.title)).toEqual(['pwsh • 3', '已退出 (1)'])
    runtime.dispose()
  })

  test('选中、关闭回到终端自己的动作；关闭会真的关掉 Host 侧的 PTY', async () => {
    const api = fakeApi([info('t1'), info('t2')])
    const runtime = runtimeOf(api)
    const { layout, calls } = fakeLayout()
    const tabs = createTerminalDockTabs({ layout, panelId: PANEL, runtime })
    let notified = 0
    const stop = tabs.subscribe(() => {
      notified += 1
    })

    await runtime.restore()
    const [first, second] = tabs.tabs().map((t) => t.id)
    expect(tabs.tabs().map((t) => t.active)).toEqual([true, false])

    tabs.onSelect(second!)
    expect(tabs.tabs().map((t) => t.active)).toEqual([false, true])
    expect(calls).toEqual([`openPanel:${PANEL}`])

    tabs.onClose(first!)
    expect(tabs.tabs().map((t) => t.id)).toEqual([second!])
    expect(api.closed).toEqual(['t1'])
    expect(notified).toBeGreaterThan(0)
    stop()
    runtime.dispose()
  })

  test('加号连开两次就是两条终端', async () => {
    const runtime = runtimeOf(fakeApi())
    const tabs = createTerminalDockTabs({ layout: fakeLayout().layout, panelId: PANEL, runtime })

    tabs.onOpen()
    tabs.onOpen()
    await tick()
    tabs.onOpen()
    expect(tabs.tabs()).toHaveLength(3)
    expect(tabs.tabs().at(-1)?.active).toBe(true)
    runtime.dispose()
  })
})

describe('最后一条终端没了：坞挪走（R-49）', () => {
  test('格清单里记着终端的归属：撤掉这一格，选中落到剩下的最后一格；别的归属不动', () => {
    const { layout, panes } = fakeLayout({
      t1: { ids: ['panels.assistant', PANEL], activeId: PANEL, open: true },
      t2: { ids: [PANEL, 'panels.assistant'], activeId: 'panels.assistant', open: true },
      t3: { ids: ['panels.assistant'], activeId: 'panels.assistant', open: true },
    })

    releaseTerminalDock(layout, PANEL)

    expect(panes().byOwner.t1).toEqual({ ids: ['panels.assistant'], activeId: 'panels.assistant', open: true })
    expect(panes().byOwner.t2).toEqual({ ids: ['panels.assistant'], activeId: 'panels.assistant', open: true })
    expect(panes().byOwner.t3).toEqual({ ids: ['panels.assistant'], activeId: 'panels.assistant', open: true })
  })

  test('只是选中停在终端上（没进格清单）：挪到剩下的最后一格；挪无可挪就不动（坞自己回启动器）', () => {
    const { layout, calls } = fakeLayout({
      t1: { ids: ['panels.review'], activeId: PANEL, open: true },
      t2: { ids: [], activeId: PANEL, open: true },
    })

    releaseTerminalDock(layout, PANEL)

    expect(calls).toEqual(['focusPane:t1:panels.review'])
  })

  test('watchLastTerminal：从有到无才挪；一开始就没有、或还剩几条都不动', async () => {
    const runtime = runtimeOf(fakeApi())
    const { layout, calls } = fakeLayout({ t1: { ids: ['panels.review', PANEL], activeId: PANEL, open: true } })
    const stop = watchLastTerminal(runtime, layout, PANEL)

    await runtime.load()
    runtime.create()
    runtime.create()
    const [a, b] = runtime.snapshot().terminals.map((t) => t.id)
    runtime.close(a!)
    expect(calls).toEqual([])

    runtime.close(b!)
    expect(calls).toEqual([`closePane:t1:${PANEL}`])
    stop()
    runtime.dispose()
  })

  test('加载失败撤下排队的那一格也算「没了」', async () => {
    const runtime = runtimeOf(fakeApi(), async () => {
      throw new TypeError('chunk missing')
    })
    const { layout, calls } = fakeLayout({ t1: { ids: ['panels.review', PANEL], activeId: PANEL, open: true } })
    const stop = watchLastTerminal(runtime, layout, PANEL)

    runtime.create()
    await tick()
    expect(runtime.count()).toBe(0)
    expect(calls).toEqual([`closePane:t1:${PANEL}`])
    stop()
  })
})
