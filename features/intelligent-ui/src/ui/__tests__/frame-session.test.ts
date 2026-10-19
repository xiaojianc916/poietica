import { describe, expect, test } from 'bun:test'
import type { IntelligentUiState } from '../../contract'
import { type FrameAsk, openFrameSession, SEND_INTERVAL_MS, STATE_SAVE_DELAY_MS } from '../frame-session'

/*
 * 卡片与外壳之间的私有端口。这里用真的 MessageChannel，测试扮演外壳那一端：拿到 render 时转交过来的端口，
 * 往回发 height / state / send …。外壳脚本自己（手势凭据、document.open 之后端口还在）由真机验收。
 */

const tick = () => Bun.sleep(5)

interface Rig {
  readonly delivered: { message: Record<string, unknown>; port: MessagePort | undefined }[]
  readonly sent: string[]
  readonly drafted: string[]
  readonly opened: string[]
  readonly saved: IntelligentUiState[]
  readonly asks: FrameAsk[]
  readonly heights: number[]
  readonly failures: string[]
  readonly fromShell: unknown[]
  active: boolean
  at: number
  /** 外壳那一端：render 交过来的端口 */
  shell(): MessagePort
  readonly session: ReturnType<typeof openFrameSession>
}

function rig(load: () => Promise<IntelligentUiState | null> = async () => null): Rig {
  const r = {
    delivered: [],
    sent: [],
    drafted: [],
    opened: [],
    saved: [],
    asks: [],
    heights: [],
    failures: [],
    fromShell: [],
    active: true,
    at: 10_000,
    shell() {
      const port = r.delivered[0]?.port
      if (port === undefined) throw new Error('还没有交出端口')
      return port
    },
  } as unknown as Rig & { session: Rig['session'] }
  ;(r as { session: Rig['session'] }).session = openFrameSession({
    html: '<p>hi</p>',
    bare: false,
    now: () => r.at,
    actions: {
      send: (text) => r.sent.push(text),
      draft: (text) => r.drafted.push(text),
      open: (url) => r.opened.push(url),
      loadState: load,
      saveState: async (state) => {
        r.saved.push(state)
      },
    },
    view: {
      deliver: (message, transfer) => {
        const port = transfer[0] as MessagePort | undefined
        if (port !== undefined) port.onmessage = (event) => r.fromShell.push(event.data)
        r.delivered.push({ message: message as Record<string, unknown>, port })
      },
      look: () => ({ css: ':root{--color-text:red}', theme: 'dark' }),
      userActive: () => r.active,
      resize: (height) => r.heights.push(height),
      fail: (message) => r.failures.push(message),
      ask: (ask) => r.asks.push(ask),
    },
  })
  return r
}

async function started(load?: () => Promise<IntelligentUiState | null>): Promise<Rig> {
  const r = rig(load)
  r.session.start()
  await tick()
  return r
}

function close(r: Rig): void {
  r.session.dispose()
  r.delivered[0]?.port?.close()
}

describe('卡片与外壳的私有端口', () => {
  test('F1 第一次 load 交出界面、令牌、主题、读回的状态与端口；再 load 不交第二次', async () => {
    const r = await started(async () => ({ model: '{"picked":"B"}', view: '{"tab":2}' }))
    expect(r.delivered).toHaveLength(1)
    expect(r.delivered[0]?.message).toEqual({
      type: 'poietica:render',
      html: '<p>hi</p>',
      css: ':root{--color-text:red}',
      theme: 'dark',
      bare: false,
      state: { model: '{"picked":"B"}', view: '{"tab":2}' },
    })
    expect(r.delivered[0]?.port).toBeDefined()
    r.session.start()
    await tick()
    expect(r.delivered).toHaveLength(1)
    close(r)
  })

  test('F2 读状态失败当没有；卸载以后读回来也不再交', async () => {
    const failed = await started(async () => {
      throw new Error('core 不在')
    })
    expect(failed.delivered[0]?.message.state).toBeNull()
    close(failed)

    let release: (state: IntelligentUiState | null) => void = () => undefined
    const slow = rig(() => new Promise((resolve) => (release = resolve)))
    slow.session.start()
    slow.session.dispose()
    release({ model: null, view: null })
    await tick()
    expect(slow.delivered).toEqual([])
  })

  test('F3 没有手势、或父窗口不在激活里：不替用户做，交给确认条', async () => {
    const r = await started()
    r.shell().postMessage({ type: 'send', text: '自动发的', gesture: false })
    r.shell().postMessage({ type: 'draft', text: '放进去', gesture: false })
    await tick()
    r.active = false
    r.shell().postMessage({ type: 'send', text: '外壳说有手势', gesture: true })
    await tick()
    expect(r.sent).toEqual([])
    expect(r.drafted).toEqual([])
    expect(r.asks).toEqual([
      { kind: 'send', text: '自动发的' },
      { kind: 'draft', text: '放进去' },
      { kind: 'send', text: '外壳说有手势' },
    ])
    close(r)
  })

  test('F4 有手势就直接办；send 一秒内只办一条，太密的那条改成确认', async () => {
    const r = await started()
    r.shell().postMessage({ type: 'send', text: '用方案 B', gesture: true })
    await tick()
    r.at += SEND_INTERVAL_MS - 1
    r.shell().postMessage({ type: 'send', text: '又一条', gesture: true })
    await tick()
    r.at += 1
    r.shell().postMessage({ type: 'send', text: '隔够了', gesture: true })
    r.shell().postMessage({ type: 'draft', text: '草稿', gesture: true })
    await tick()
    expect(r.sent).toEqual(['用方案 B', '隔够了'])
    expect(r.drafted).toEqual(['草稿'])
    expect(r.asks).toEqual([{ kind: 'send', text: '又一条' }])
    close(r)
  })

  test('F5 外链：只放 http(s)/mailto，别的协议连确认都不给', async () => {
    const r = await started()
    r.shell().postMessage({ type: 'open', url: 'javascript:alert(1)', gesture: true })
    r.shell().postMessage({ type: 'open', url: 'https://example.com/a', gesture: true })
    r.shell().postMessage({ type: 'open', url: 'https://example.com/b', gesture: false })
    await tick()
    expect(r.opened).toEqual(['https://example.com/a'])
    expect(r.asks).toEqual([{ kind: 'open', url: 'https://example.com/b' }])
    close(r)
  })

  test('F6 状态攒一会儿整份写回，只写最后一份；卸载时立刻写掉没写完的', async () => {
    const r = await started()
    r.shell().postMessage({ type: 'state', model: '{"n":1}', view: null })
    r.shell().postMessage({ type: 'state', model: '{"n":2}', view: '{"tab":1}' })
    await tick()
    expect(r.saved).toEqual([])
    await Bun.sleep(STATE_SAVE_DELAY_MS + 20)
    expect(r.saved).toEqual([{ model: '{"n":2}', view: '{"tab":1}' }])
    r.shell().postMessage({ type: 'state', model: '{"n":3}', view: null })
    await tick()
    r.session.dispose()
    expect(r.saved.at(-1)).toEqual({ model: '{"n":3}', view: null })
    expect(r.saved).toHaveLength(2)
    r.shell().close()
  })

  test('F7 高度与报错照转；认不出的消息与卸载之后的消息都不理；换主题只推给已开的界面', async () => {
    const early = rig()
    early.session.retheme()
    expect(early.delivered).toEqual([])
    close(early)

    const r = await started()
    r.shell().postMessage({ type: 'height', height: 381.4 })
    r.shell().postMessage({ type: 'error', message: 'boom' })
    r.shell().postMessage({ type: 'poietica:send', text: '旧名字' })
    r.shell().postMessage('garbage')
    await tick()
    expect(r.heights).toEqual([382])
    expect(r.failures).toEqual(['boom'])
    expect(r.asks).toEqual([])
    r.session.retheme()
    await tick()
    expect(r.fromShell).toEqual([{ type: 'theme', css: ':root{--color-text:red}', theme: 'dark' }])
    r.session.dispose()
    r.shell().postMessage({ type: 'height', height: 10 })
    await tick()
    expect(r.heights).toEqual([382])
    r.shell().close()
  })
})
