import { afterEach, describe, expect, test } from 'bun:test'
import { createTestLogger } from '@poietica/test-kit'
import { cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import type { TerminalInfo } from '../../contract'
import type { TerminalApi } from '../api'
import { createLazyTerminalRuntime } from '../terminal-loader'
import { TerminalPanel } from '../terminal-panel'
import * as storeModule from '../terminal-store'

/* P-06：判据是「什么时候才去加载模块」与「加载前后行为不变」：加载由注入的 loadModule 计数，模块本身用真的 terminal-store。 */

const info = (terminalId: string): TerminalInfo => ({
  terminalId,
  cwd: 'C:\\work',
  shell: 'pwsh.exe',
  title: 'pwsh',
  exited: false,
  exitCode: null,
})

function fakeApi(restored: readonly TerminalInfo[] = []) {
  const calls: string[] = []
  const api: TerminalApi = {
    async open() {
      calls.push('open')
      return info('t9')
    },
    async write() {
      return undefined
    },
    async resize() {
      return undefined
    },
    async close() {
      return undefined
    },
    async list() {
      calls.push('list')
      return restored
    },
    async replay(terminalId) {
      calls.push(`replay:${terminalId}`)
      return { data: '', endOffset: 0 }
    },
    onOutput: () => ({ dispose: () => undefined }),
    onExited: () => ({ dispose: () => undefined }),
  }
  return { api, calls }
}

function loader() {
  const state = { loads: 0, gate: null as Promise<void> | null, fail: false }
  const loadModule = async () => {
    state.loads += 1
    await state.gate
    if (state.fail) throw new TypeError('chunk missing')
    return storeModule
  }
  return { state, loadModule }
}

function open(restored: readonly TerminalInfo[] = []) {
  const { api, calls } = fakeApi(restored)
  const { state, loadModule } = loader()
  const errors: string[] = []
  const runtime = createLazyTerminalRuntime({
    api,
    logger: createTestLogger(),
    cwd: () => null,
    openExternal: () => undefined,
    onError: (_error, title) => {
      errors.push(title)
    },
    loadModule,
  })
  return { runtime, calls, state, errors }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  cleanup()
})

describe('P-06 终端按需加载', () => {
  test('L1 重载恢复时 Host 里没有终端：只问一次清单，不加载 xterm', async () => {
    const { runtime, calls, state } = open([])
    await runtime.restore()
    expect(state.loads).toBe(0)
    expect(calls).toEqual(['list'])
    expect(runtime.current()).toBeUndefined()
    expect(runtime.count()).toBe(0)
  })

  test('L2 Host 里还有终端：加载并照旧恢复（清单按最新的再走一遍）', async () => {
    const { runtime, calls, state } = open([info('t1')])
    await runtime.restore()
    expect(state.loads).toBe(1)
    expect(runtime.count()).toBe(1)
    expect(calls).toEqual(['list', 'list', 'replay:t1'])
    runtime.dispose()
  })

  test('L3 加载前连按两次新建：标签立刻上两格，加载完还是这两格（同一个 id），模块只加载一次', async () => {
    const { runtime, state } = open()
    runtime.create()
    runtime.create()
    const queued = runtime.snapshot()
    expect(queued.terminals.map((t) => t.info)).toEqual([null, null])
    expect(queued.activeId).toBe(queued.terminals[1]!.id)
    expect(runtime.count()).toBe(2)
    expect(runtime.session(queued.terminals[0]!.id)).toBeUndefined()
    await tick()
    expect(state.loads).toBe(1)
    expect(runtime.snapshot().terminals.map((t) => t.id)).toEqual(queued.terminals.map((t) => t.id))
    expect(runtime.snapshot().activeId).toBe(queued.activeId)
    expect(runtime.session(queued.terminals[0]!.id)).toBeDefined()
    runtime.dispose()
  })

  test('L4 加载完之后新建是同步的（与旧行为一致）', async () => {
    const { runtime } = open()
    await runtime.load()
    runtime.create()
    expect(runtime.count()).toBe(1)
    runtime.dispose()
  })

  test('L5 加载前到达的输出 / 退出通知直接丢弃，不抛错', () => {
    const { runtime, state } = open()
    expect(() => {
      runtime.writeToHost('t1', 'early', 0)
      runtime.markHostExited('t1', 0)
      runtime.closeActive()
      runtime.clearActive()
    }).not.toThrow()
    expect(state.loads).toBe(0)
  })

  test('L6 加载途中功能被拆掉：建出来的运行时立刻收尾，不再新建', async () => {
    const { runtime, state } = open()
    let release = (): void => undefined
    state.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    runtime.create()
    runtime.dispose()
    release()
    await tick()
    expect(runtime.count()).toBe(0)
  })

  test('L7 加载失败：报一次错，下一次触发重新加载', async () => {
    const { runtime, state, errors } = open()
    state.fail = true
    runtime.create()
    await tick()
    expect(errors).toEqual(['终端没能加载'])
    state.fail = false
    runtime.create()
    await tick()
    expect(state.loads).toBe(2)
    expect(runtime.count()).toBe(1)
    runtime.dispose()
  })

  test('L8 加载前就关掉排队的那一格：加载完不再建它，也不开 PTY', async () => {
    const { runtime, calls } = open()
    runtime.create()
    runtime.create()
    const [first, second] = runtime.snapshot().terminals.map((t) => t.id)
    runtime.close(first!)
    expect(runtime.snapshot().terminals.map((t) => t.id)).toEqual([second!])
    await tick()
    expect(runtime.snapshot().terminals.map((t) => t.id)).toEqual([second!])
    expect(calls).not.toContain('open')
    runtime.dispose()
  })

  test('L9 加载前选中别的那一格：加载完选中不变', async () => {
    const { runtime } = open()
    runtime.create()
    runtime.create()
    const first = runtime.snapshot().terminals[0]!.id
    runtime.select(first)
    expect(runtime.snapshot().activeId).toBe(first)
    await tick()
    expect(runtime.snapshot().activeId).toBe(first)
    runtime.dispose()
  })

  test('L10 加载失败：排队的标签撤下，连按几次也只报一次错', async () => {
    const { runtime, state, errors } = open()
    state.fail = true
    runtime.create()
    runtime.create()
    expect(runtime.count()).toBe(2)
    await tick()
    expect(runtime.count()).toBe(0)
    expect(errors).toEqual(['终端没能加载'])
  })

  test('L11 订阅者在排队、加载完成与之后每次 store 变化时都收到通知；snapshot 引用在状态不变时稳定', async () => {
    const { runtime } = open()
    let seen = 0
    const stop = runtime.subscribe(() => {
      seen += 1
    })
    const empty = runtime.snapshot()
    expect(runtime.snapshot()).toBe(empty)
    runtime.create()
    expect(seen).toBe(1)
    const queued = runtime.snapshot()
    expect(runtime.snapshot()).toBe(queued)
    await tick()
    const afterLoad = seen
    expect(afterLoad).toBeGreaterThan(1)
    runtime.create()
    expect(seen).toBeGreaterThan(afterLoad)
    stop()
    const settled = seen
    runtime.create()
    expect(seen).toBe(settled)
    runtime.dispose()
  })

  test('L12 面板静态挂载、不等 xterm：加载前没有画面，加载完排队的那一格有了画面', async () => {
    const { runtime, state } = open()
    let release = (): void => undefined
    state.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    runtime.create()
    const { container } = render(createElement(TerminalPanel, { runtime }))
    const panel = container.querySelector('[data-terminal-panel]')
    expect(panel).not.toBeNull()
    expect(panel!.querySelector('.xterm')).toBeNull()
    release()
    await tick()
    await tick()
    expect(container.querySelector('[data-terminal-panel] .xterm')).not.toBeNull()
    runtime.dispose()
  })
})
