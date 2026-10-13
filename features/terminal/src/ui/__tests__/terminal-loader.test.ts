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

  test('L3 加载前连按两次新建：加载完正好两条，模块只加载一次', async () => {
    const { runtime, state } = open()
    runtime.create()
    runtime.create()
    expect(runtime.count()).toBe(0)
    await tick()
    expect(state.loads).toBe(1)
    expect(runtime.count()).toBe(2)
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

  /* 命令里先 openPanel 再 create()，面板是 lazy(Promise.all([load(), import(面板)]))。create() 的续体先挂在同一个 load() 上，必然先于
   * 面板挂载执行；面板挂载时 count() 已是 1，它「没有终端就先开一条」的 effect 不会再开第二条。 */
  test('L8 新建命令 + 面板首次挂载：只开出一条终端', async () => {
    const { runtime } = open()
    runtime.create()
    /* 最贴近「面板分块已在缓存里」的最紧情形。 */
    const [loaded] = await Promise.all([runtime.load(), Promise.resolve(TerminalPanel)])
    render(createElement(TerminalPanel, { runtime: loaded }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(runtime.count()).toBe(1)
    runtime.dispose()
  })
})
