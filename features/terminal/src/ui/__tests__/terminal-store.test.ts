import { describe, expect, test } from 'bun:test'
import { createTestLogger } from '@poietica/test-kit'
import type { TerminalInfo } from '../../contract'
import type { TerminalApi } from '../api'
import { createTerminalRuntime, terminalTabLabel } from '../terminal-store'

const info = (terminalId: string, over: Partial<TerminalInfo> = {}): TerminalInfo => ({
  terminalId,
  cwd: 'C:\\work',
  shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  title: 'pwsh',
  exited: false,
  exitCode: null,
  ...over,
})

interface FakeApi extends TerminalApi {
  readonly calls: string[]
  readonly opened: TerminalInfo[]
  readonly closed: string[]
  readonly written: Array<{ terminalId: string; data: string }>
  readonly outputs: Array<(p: { terminalId: string; data: string; offset: number }) => void>
  readonly exits: Array<(p: { terminalId: string; exitCode: number | null }) => void>
  restored: readonly TerminalInfo[]
  replayData: { data: string; endOffset: number }
  /** 非 null 时 list / replay 先等这道门，用来把「订阅之后、重放回来之前」这一刻钉住 */
  listGate: Promise<void> | null
  replayGate: Promise<void> | null
  /** 非 null 时 replay 以它拒绝（模拟 Host 侧读不到） */
  replayError: Error | null
}

function fakeApi(): FakeApi {
  const calls: string[] = []
  const opened: TerminalInfo[] = []
  const closed: string[] = []
  const written: Array<{ terminalId: string; data: string }> = []
  const outputs: Array<(p: { terminalId: string; data: string; offset: number }) => void> = []
  const exits: Array<(p: { terminalId: string; exitCode: number | null }) => void> = []
  const api: FakeApi = {
    calls,
    opened,
    closed,
    written,
    outputs,
    exits,
    restored: [],
    replayData: { data: '', endOffset: 0 },
    listGate: null,
    replayGate: null,
    replayError: null,
    async open(o) {
      calls.push(`open:${String(o.cwd)}:${o.cols}x${o.rows}`)
      const next = info(`t${opened.length + 1}`)
      opened.push(next)
      return next
    },
    async write(terminalId, data) {
      written.push({ terminalId, data })
    },
    async resize(terminalId, cols, rows) {
      calls.push(`resize:${terminalId}:${cols}x${rows}`)
    },
    async close(terminalId) {
      calls.push(`close:${terminalId}`)
      closed.push(terminalId)
    },
    async list() {
      calls.push('list')
      await api.listGate
      return api.restored
    },
    async replay(terminalId) {
      calls.push(`replay:${terminalId}`)
      await api.replayGate

      if (api.replayError !== null) {
        throw api.replayError
      }

      return api.replayData
    },
    onOutput(listener) {
      outputs.push(listener)
      return { dispose: () => outputs.splice(outputs.indexOf(listener), 1) }
    },
    onExited(listener) {
      exits.push(listener)
      return { dispose: () => exits.splice(exits.indexOf(listener), 1) }
    },
  }
  return api
}

function makeRuntime(api: FakeApi, cwd: string | null = 'C:\\work') {
  return createTerminalRuntime({
    api,
    logger: createTestLogger(),
    cwd: () => cwd,
    openExternal: () => undefined,
    onError: () => undefined,
  })
}

describe('terminal 标签文字（07 页 §11E 的标签条）', () => {
  test('运行中：`title • 序号`', () => {
    expect(terminalTabLabel({ id: 'local-1', info: info('t12') })).toBe('pwsh • 12')
  })

  test('已退出：`已退出 (code)`', () => {
    expect(terminalTabLabel({ id: 'local-1', info: info('t3', { exited: true, exitCode: 0 }) })).toBe('已退出 (0)')
  })

  test('退出但拿不到 code：只写「已退出」', () => {
    expect(terminalTabLabel({ id: 'local-1', info: info('t3', { exited: true, exitCode: null }) })).toBe('已退出')
  })

  test('PTY 还没开出来时标签占位', () => {
    expect(terminalTabLabel({ id: 'local-1', info: null })).toBe('终端')
  })
})

describe('terminal runtime：标签清单与活动项', () => {
  test('create 立刻上标签（PTY 还没开），activeId 指向它', () => {
    const runtime = makeRuntime(fakeApi())
    const id = runtime.create()
    expect(runtime.count()).toBe(1)
    expect(runtime.store.getState().activeId).toBe(id)
    expect(runtime.store.getState().terminals[0]?.info).toBeNull()
  })

  test('close 关掉后 activeId 接到右邻，没有右邻接左邻', () => {
    const runtime = makeRuntime(fakeApi())
    const a = runtime.create()
    const b = runtime.create()
    const c = runtime.create()

    runtime.select(b)
    runtime.close(b)
    expect(runtime.store.getState().activeId).toBe(c)
    expect(runtime.count()).toBe(2)

    runtime.close(c)
    expect(runtime.store.getState().activeId).toBe(a)

    runtime.close(a)
    expect(runtime.store.getState().activeId).toBeNull()
    expect(runtime.count()).toBe(0)
  })

  test('close 会真的关 Host 侧的 PTY（会话表里拿得到 terminalId 时）', async () => {
    const api = fakeApi()
    api.restored = [info('t9')]
    const runtime = makeRuntime(api)

    await runtime.restore()

    const id = runtime.store.getState().terminals[0]!.id

    runtime.close(id)
    expect(api.closed).toEqual(['t9'])
  })

  test('closeActive 只作用在活动标签上', async () => {
    const api = fakeApi()
    api.restored = [info('t1'), info('t2')]
    const runtime = makeRuntime(api)

    await runtime.restore()

    const first = runtime.store.getState().terminals[0]!.id

    expect(runtime.store.getState().activeId).toBe(first)
    runtime.closeActive()
    expect(api.closed).toEqual(['t1'])
    expect(runtime.count()).toBe(1)
  })

  test('没有终端时 closeActive / clearActive 不做任何事', () => {
    const api = fakeApi()
    const runtime = makeRuntime(api)
    runtime.closeActive()
    runtime.clearActive()
    expect(api.calls.filter((c) => c.startsWith('close:'))).toEqual([])
  })
})

describe('terminal runtime：重载恢复（list + replay）', () => {
  test('恢复出 Host 里还活着的终端，并按 terminalId 配好分发', async () => {
    const api = fakeApi()
    api.restored = [info('t1'), info('t2', { exited: true, exitCode: 0 })]
    api.replayData = { data: 'old output', endOffset: 10 }
    const runtime = makeRuntime(api)

    await runtime.restore()
    expect(api.calls).toEqual(['list', 'replay:t1', 'replay:t2'])
    expect(runtime.count()).toBe(2)
    expect(runtime.store.getState().terminals.map((t) => t.info?.terminalId)).toEqual(['t1', 't2'])
    /* 恢复出来的标签：没有别的活动标签时挑第一条 */
    expect(runtime.store.getState().activeId).toBe(runtime.store.getState().terminals[0]!.id)

    /* 通知按 terminalId 落到恢复出来的画面上（用不上 DOM 也能观测：写进 xterm 的缓冲） */
    runtime.writeToHost('t1', 'live', 10)
    const first = runtime.store.getState().terminals[0]!.id

    expect(runtime.session(first)?.terminal.buffer.active.length).toBeGreaterThan(0)
  })

  test('恢复不会重开已经在表里的终端', async () => {
    const api = fakeApi()
    api.restored = [info('t1')]
    const runtime = makeRuntime(api)
    await runtime.restore()
    await runtime.restore()
    expect(runtime.count()).toBe(1)
    expect(api.calls.filter((c) => c === 'list').length).toBe(2)
  })

  test('已有活动标签时恢复不抢焦点', async () => {
    const api = fakeApi()
    const runtime = makeRuntime(api)
    const own = runtime.create()
    api.restored = [info('t1')]
    await runtime.restore()
    expect(runtime.store.getState().activeId).toBe(own)
    expect(runtime.count()).toBe(2)
  })
})

describe('R-08-15: 重放与实时输出按 offset 对齐', () => {
  /** 画面上的文字（xterm 的写是异步的，等一拍再读缓冲） */
  const screen = async (runtime: ReturnType<typeof makeRuntime>, id: string): Promise<string> => {
    await new Promise((resolve) => setTimeout(resolve, 15))
    const buffer = runtime.session(id)?.terminal.buffer.active

    if (buffer === undefined) {
      return ''
    }

    const lines: string[] = []

    for (let i = 0; i < buffer.length; i += 1) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
    }

    return lines.join('\n').trim()
  }

  /** 让 restore() 停在「已订阅、replay 还没回来」这一刻 */
  const gated = (): { api: FakeApi; release: () => void } => {
    const api = fakeApi()
    let release!: () => void
    api.replayGate = new Promise<void>((resolve) => {
      release = resolve
    })
    return { api, release }
  }

  /** 与 restore() 并行：等到 replay 真的被叫了（list 已经回来） */
  const untilReplaying = async (api: FakeApi): Promise<void> => {
    for (let i = 0; i < 50 && !api.calls.includes('replay:t1'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(api.calls).toContain('replay:t1')
  }

  test('replay 窗口里到达的、已被重放覆盖的通知不再写第二遍', async () => {
    const { api, release } = gated()
    api.restored = [info('t1')]
    api.replayData = { data: 'ping\r\npong\r\n', endOffset: 12 }
    const runtime = makeRuntime(api)

    const restoring = runtime.restore()
    await untilReplaying(api)

    /* 重放回来之前，Host 把同一段输出又推了一遍（0..10） */
    runtime.writeToHost('t1', 'ping\r\npong\r\n', 0)
    release()
    await restoring

    const id = runtime.store.getState().terminals[0]!.id
    expect(await screen(runtime, id)).toBe('ping\npong')
  })

  test('与重放部分重叠的通知只写没覆盖到的尾巴', async () => {
    const { api, release } = gated()
    api.restored = [info('t1')]
    api.replayData = { data: 'abcdef', endOffset: 6 }
    const runtime = makeRuntime(api)

    const restoring = runtime.restore()
    await untilReplaying(api)

    /* 通知从 4 开始：前 2 个码元（ef）已经在重放里 */
    runtime.writeToHost('t1', 'efgh', 4)
    release()
    await restoring

    const id = runtime.store.getState().terminals[0]!.id
    expect(await screen(runtime, id)).toBe('abcdefgh')
  })

  test('重放没覆盖到的新输出原样写进去', async () => {
    const { api, release } = gated()
    api.restored = [info('t1')]
    api.replayData = { data: 'old', endOffset: 3 }
    const runtime = makeRuntime(api)

    const restoring = runtime.restore()
    await untilReplaying(api)

    runtime.writeToHost('t1', 'new', 3)
    runtime.writeToHost('t1', 'er', 6)
    release()
    await restoring

    const id = runtime.store.getState().terminals[0]!.id
    expect(await screen(runtime, id)).toBe('oldnewer')
  })

  test('攒下的通知按到达顺序放行，不重排', async () => {
    const { api, release } = gated()
    api.restored = [info('t1')]
    api.replayData = { data: 'a', endOffset: 1 }
    const runtime = makeRuntime(api)

    const restoring = runtime.restore()
    await untilReplaying(api)

    runtime.writeToHost('t1', 'b', 1)
    runtime.writeToHost('t1', 'c', 2)
    runtime.writeToHost('t1', 'd', 3)
    release()
    await restoring

    const id = runtime.store.getState().terminals[0]!.id
    expect(await screen(runtime, id)).toBe('abcd')
  })

  test('replay 之后来的通知不再被攒着（cursor 已经在走）', async () => {
    const api = fakeApi()
    api.restored = [info('t1')]
    api.replayData = { data: 'aa', endOffset: 2 }
    const runtime = makeRuntime(api)

    await runtime.restore()

    const id = runtime.store.getState().terminals[0]!.id
    runtime.writeToHost('t1', 'bb', 2)
    expect(await screen(runtime, id)).toBe('aabb')
  })

  test('replay 失败：攒下的通知仍然写进画面，不卡在缓冲里', async () => {
    const api = fakeApi()
    api.restored = [info('t1')]
    api.replayError = new Error('host 没了')
    const runtime = makeRuntime(api)

    const restoring = runtime.restore()
    await untilReplaying(api)
    runtime.writeToHost('t1', 'live', 0)
    await restoring

    const id = runtime.store.getState().terminals[0]!.id
    expect(await screen(runtime, id)).toBe('live')
  })

  test('关闭终端时把它攒下的输出一起丢掉', async () => {
    const { api, release } = gated()
    api.restored = [info('t1')]
    api.replayData = { data: '', endOffset: 0 }
    const runtime = makeRuntime(api)

    const restoring = runtime.restore()
    await untilReplaying(api)
    runtime.writeToHost('t1', 'late', 0)

    const id = runtime.store.getState().terminals[0]?.id

    if (id === undefined) {
      throw new Error('恢复中的终端应该已经上标签了')
    }

    runtime.close(id)
    release()
    await restoring

    /* 关掉的会话不该再被写：攒下的那一段既没人写，也不该留在表里 */
    expect(runtime.session(id)).toBeUndefined()
    expect(runtime.count()).toBe(0)
  })
})

describe('terminal runtime：dispose', () => {
  test('dispose 关掉每个还认得的 Host 终端', async () => {
    const api = fakeApi()
    api.restored = [info('t1'), info('t2')]
    const runtime = makeRuntime(api)

    await runtime.restore()

    runtime.dispose()
    expect(api.closed).toEqual(['t1', 't2'])
  })
})
