import { describe, expect, test } from 'bun:test'
import { INTELLIGENT_UI_TWEAK_GROUPS_MAX, type IntelligentUiState } from '../../contract'
import type { TweakGroup } from '../bridge'
import {
  canUseTools,
  type FrameAsk,
  openFrameSession,
  SEND_INTERVAL_MS,
  STATE_SAVE_DELAY_MS,
  tweakingAfterGroups,
} from '../frame-session'

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
  readonly tweaks: (readonly TweakGroup[])[]
  readonly fromShell: unknown[]
  /** render 成功投递的次数 */
  rendered: number
  /** deliver 抛错（测试投递失败回滚） */
  deliverFails: boolean
  loads: number
  active: boolean
  at: number
  /** 外壳那一端：render 交过来的端口 */
  shell(): MessagePort
  readonly session: ReturnType<typeof openFrameSession>
}

function rig(load: () => Promise<IntelligentUiState | null> = async () => null, live = true): Rig {
  const r = {
    delivered: [],
    sent: [],
    drafted: [],
    opened: [],
    saved: [],
    asks: [],
    heights: [],
    failures: [],
    tweaks: [],
    fromShell: [],
    rendered: 0,
    deliverFails: false,
    loads: 0,
    active: true,
    at: 10_000,
    shell() {
      const port = r.delivered[0]?.port
      if (port === undefined) throw new Error('还没有交出端口')
      return port
    },
  } as unknown as Rig & { session: Rig['session'] }
  ;(r as { session: Rig['session'] }).session = openFrameSession({
    content: { html: '<p>hi</p>', bare: false, wide: false },
    live,
    now: () => r.at,
    actions: {
      send: (text) => r.sent.push(text),
      draft: (text) => r.drafted.push(text),
      open: (url) => r.opened.push(url),
      loadState: () => {
        r.loads += 1
        return load()
      },
      saveState: async (state) => {
        r.saved.push(state)
      },
    },
    view: {
      deliver: (message, transfer) => {
        if (r.deliverFails) throw new Error('投递失败')
        const port = transfer[0] as MessagePort | undefined
        if (port !== undefined) port.onmessage = (event) => r.fromShell.push(event.data)
        r.delivered.push({ message: message as Record<string, unknown>, port })
      },
      look: () => ({ css: ':root{--color-text:red}', theme: 'dark' }),
      userActive: () => r.active,
      resize: (height) => r.heights.push(height),
      fail: (message) => r.failures.push(message),
      ask: (ask) => r.asks.push(ask),
      tweaks: (groups) => r.tweaks.push(groups),
      rendered: () => {
        r.rendered += 1
      },
    },
  })
  return r
}

async function started(load?: () => Promise<IntelligentUiState | null>, live = true): Promise<Rig> {
  const r = rig(load, live)
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
    const r = await started(async () => ({ model: '{"picked":"B"}', view: '{"tab":2}', tweaks: null }))
    expect(r.delivered).toHaveLength(1)
    expect(r.delivered[0]?.message).toEqual({
      type: 'poietica:render',
      html: '<p>hi</p>',
      css: ':root{--color-text:red}',
      theme: 'dark',
      bare: false,
      wide: false,
      state: { model: '{"picked":"B"}', view: '{"tab":2}', tweaks: null },
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
    release({ model: null, view: null, tweaks: null })
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
    r.shell().postMessage({ type: 'state', model: '{"n":1}', view: null, tweaks: null })
    r.shell().postMessage({ type: 'state', model: '{"n":2}', view: '{"tab":1}', tweaks: '{"g":{"k":2}}' })
    await tick()
    expect(r.saved).toEqual([])
    expect(r.session.state()).toEqual({ model: '{"n":2}', view: '{"tab":1}', tweaks: '{"g":{"k":2}}' })
    await Bun.sleep(STATE_SAVE_DELAY_MS + 20)
    expect(r.saved).toEqual([{ model: '{"n":2}', view: '{"tab":1}', tweaks: '{"g":{"k":2}}' }])
    r.shell().postMessage({ type: 'state', model: '{"n":3}', view: null, tweaks: null })
    await tick()
    r.session.dispose()
    expect(r.saved.at(-1)).toEqual({ model: '{"n":3}', view: null, tweaks: null })
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

  test('F8 预览：先以 preview 交出（不读状态）；每来一版推一次、同一版不重推；预览期间只认高度', async () => {
    const r = await started(async () => ({ model: '{"n":1}', view: null, tweaks: null }), false)
    expect(r.loads).toBe(0)
    expect(r.delivered[0]?.message).toEqual({
      type: 'poietica:render',
      preview: true,
      html: '<p>hi</p>',
      css: ':root{--color-text:red}',
      theme: 'dark',
      bare: false,
      wide: false,
    })
    r.session.preview('<p>hi</p><p>more')
    r.session.preview('<p>hi</p><p>more')
    r.shell().postMessage({ type: 'height', height: 40 })
    r.shell().postMessage({ type: 'state', model: '{"forged":true}', view: null, tweaks: null })
    r.shell().postMessage({ type: 'send', text: '预览里不该有', gesture: true })
    await tick()
    expect(r.fromShell).toEqual([{ type: 'preview', html: '<p>hi</p><p>more' }])
    expect(r.heights).toEqual([40])
    expect(r.sent).toEqual([])
    expect(r.session.state()).toEqual({ model: null, view: null, tweaks: null })
    close(r)
  })

  test('F9 定稿：读回状态后经端口换成真界面（同一个 iframe），之后预览不再推；状态与消息照常', async () => {
    const r = await started(async () => ({ model: '{"n":1}', view: null, tweaks: null }), false)
    r.session.finish({ html: '<p>final</p>', bare: true, wide: true })
    r.session.finish({ html: '<p>again</p>', bare: false, wide: false })
    await tick()
    expect(r.loads).toBe(1)
    expect(r.delivered).toHaveLength(1)
    expect(r.fromShell).toEqual([
      {
        type: 'render',
        html: '<p>final</p>',
        css: ':root{--color-text:red}',
        theme: 'dark',
        bare: true,
        wide: true,
        state: { model: '{"n":1}', view: null, tweaks: null },
      },
    ])
    r.session.preview('<p>late</p>')
    r.shell().postMessage({ type: 'send', text: '真界面', gesture: true })
    await tick()
    expect(r.fromShell).toHaveLength(1)
    expect(r.sent).toEqual(['真界面'])
    expect(r.session.state()).toEqual({ model: '{"n":1}', view: null, tweaks: null })
    close(r)
  })

  test('F10 还没 load 就定稿：第一次 load 直接交真界面；还没 load 时来的预览改的是待交的那一版', async () => {
    const early = rig(async () => null, false)
    early.session.preview('<p>v2</p>')
    early.session.start()
    await tick()
    expect(early.delivered[0]?.message.html).toBe('<p>v2</p>')
    expect(early.delivered[0]?.message.preview).toBe(true)
    close(early)

    const done = rig(async () => null, false)
    done.session.finish({ html: '<p>final</p>', bare: false, wide: false })
    done.session.start()
    await tick()
    expect(done.delivered[0]?.message.preview).toBeUndefined()
    expect(done.delivered[0]?.message.html).toBe('<p>final</p>')
    expect(done.delivered[0]?.message.state).toBeNull()
    close(done)
  })

  const group = (id: number, label = `组 ${id}`) => ({
    type: 'tweak',
    op: 'register',
    id,
    label,
    controls: [
      { type: 'range', key: 'r', label: '圆角', min: 0, max: 24, step: 1, unit: 'px', value: 8 },
      { type: 'toggle', key: 't', label: '阴影', value: true },
    ],
    values: { r: 8, t: true },
  })

  test('F11 调整面板：登记 / 撤掉照转给卡片；卡片改值经端口回送（收进范围、只改给出的那几项）', async () => {
    const r = await started()
    r.shell().postMessage(group(1))
    await tick()
    expect(r.tweaks.at(-1)?.map((g) => g.label)).toEqual(['组 1'])
    r.session.setTweak(1, { r: 99 })
    r.session.setTweak(7, { r: 1 })
    await tick()
    expect(r.fromShell).toEqual([{ type: 'tweak.values', id: 1, values: { r: 24, t: true } }])
    expect(r.tweaks.at(-1)?.[0]?.values).toEqual({ r: 24, t: true })
    r.shell().postMessage({ type: 'tweak', op: 'dispose', id: 1 })
    await tick()
    expect(r.tweaks.at(-1)).toEqual([])
    close(r)
  })

  test('F13 工具条时机：预览量到高度不算 render，真界面投递后才通知一次，卸载后不再通知', async () => {
    const r = await started(async () => null, false)
    r.shell().postMessage({ type: 'height', height: 120 })
    await tick()
    expect(r.heights).toEqual([120])
    expect(r.rendered).toBe(0)

    r.session.finish({ html: '<p>final</p>', bare: false, wide: false })
    await tick()
    expect(r.rendered).toBe(1)

    r.session.start()
    r.session.finish({ html: '<p>again</p>', bare: false, wide: false })
    await tick()
    expect(r.rendered).toBe(1)

    r.session.dispose()
    await tick()
    expect(r.rendered).toBe(1)
    r.delivered[0]?.port?.close()

    /* 读状态还没回来就卸载：之后也不许补发 rendered */
    let release: (state: IntelligentUiState | null) => void = () => undefined
    const slow = rig(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
      true,
    )
    slow.session.start()
    await tick()
    slow.session.dispose()
    release({ model: null, view: null, tweaks: null })
    await tick()
    expect(slow.rendered).toBe(0)
    expect(slow.delivered).toEqual([])
  })

  test('F14 消息竞态：loadState 成功后立刻发来的 state / error 不被丢掉，预览期仍然只认 height', async () => {
    let release: (state: IntelligentUiState | null) => void = () => undefined
    const r = rig(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
      false,
    )
    r.session.start()
    r.shell().postMessage({ type: 'state', model: '{"bad":1}', view: null, tweaks: null })
    r.shell().postMessage({ type: 'error', message: '预览里的错' })
    await tick()
    expect(r.session.state()).toEqual({ model: null, view: null, tweaks: null })
    expect(r.failures).toEqual([])

    r.session.finish({ html: '<p>final</p>', bare: false, wide: false })
    release({ model: '{"n":1}', view: null, tweaks: null })
    await tick()
    expect(r.rendered).toBe(1)
    r.shell().postMessage({ type: 'state', model: '{"n":2}', view: '{"tab":1}', tweaks: null })
    r.shell().postMessage({ type: 'error', message: '真界面里的错' })
    await tick()
    expect(r.session.state()).toEqual({ model: '{"n":2}', view: '{"tab":1}', tweaks: null })
    expect(r.failures).toEqual(['真界面里的错'])
    close(r)
  })

  test('F15 投递抛错：走 fail、不通知 rendered，回滚后允许再试', async () => {
    const r = rig(async () => null, true)
    r.deliverFails = true
    r.session.start()
    await tick()
    expect(r.failures).toEqual(['投递失败'])
    expect(r.rendered).toBe(0)
    expect(r.delivered).toEqual([])

    r.deliverFails = false
    r.session.start()
    await tick()
    expect(r.delivered).toHaveLength(1)
    expect(r.delivered[0]?.message.type).toBe('poietica:render')
    expect(r.rendered).toBe(1)
    expect(r.failures).toEqual(['投递失败'])
    close(r)
  })

  test('F15b 定稿经端口投递抛错：走 fail、不通知 rendered；端口恢复后可以再试', async () => {
    const r = await started(async () => null, false)
    /* happy-dom 的 MessagePort 原型与全局 MessagePort 不是同一个，直接从端口取原型来打桩 */
    const proto: object = Object.getPrototypeOf(r.shell())
    const original = Reflect.get(proto, 'postMessage') as unknown
    Reflect.set(proto, 'postMessage', () => {
      throw new Error('端口投递失败')
    })
    try {
      r.session.finish({ html: '<p>final</p>', bare: false, wide: false })
      await tick()
      expect(r.failures).toEqual(['端口投递失败'])
      expect(r.rendered).toBe(0)
      expect(r.fromShell).toEqual([])
    } finally {
      Reflect.set(proto, 'postMessage', original)
    }

    r.session.finish({ html: '<p>final</p>', bare: false, wide: false })
    await tick()
    expect(r.fromShell).toEqual([
      {
        type: 'render',
        html: '<p>final</p>',
        css: ':root{--color-text:red}',
        theme: 'dark',
        bare: false,
        wide: false,
        state: null,
      },
    ])
    expect(r.rendered).toBe(1)
    close(r)
  })

  test('F16 setTweak 入参防御：null / 非对象 / 数组不抛错、不改值、不回送', async () => {
    const r = await started()
    r.shell().postMessage(group(1))
    await tick()
    for (const bad of [null, undefined, 3, 'x', true, [], [1, 2]]) {
      expect(() => r.session.setTweak(1, bad)).not.toThrow()
    }
    await tick()
    expect(r.fromShell).toEqual([])
    expect(r.tweaks.at(-1)?.[0]?.values).toEqual({ r: 8, t: true })
    close(r)
  })

  test('F17 卸载清理：组不残留、端口不再处理消息、没写完的状态立即写掉', async () => {
    const r = await started()
    r.shell().postMessage(group(1))
    r.shell().postMessage({ type: 'state', model: '{"n":1}', view: null, tweaks: null })
    await tick()
    const port = r.shell()
    r.session.dispose()
    expect(r.tweaks.at(-1)).toEqual([])
    expect(r.saved).toEqual([{ model: '{"n":1}', view: null, tweaks: null }])
    port.postMessage({ type: 'height', height: 99 })
    port.postMessage({ type: 'send', text: '卸载后', gesture: true })
    await tick()
    expect(r.heights).toEqual([])
    expect(r.sent).toEqual([])
    expect(r.session.setTweak(1, { r: 3 })).toBeUndefined()
    expect(r.fromShell).toEqual([])
    port.close()
  })

  test('F18 组名唯一：同 label 不同 id 的第二组被拒绝，同 id 重登记仍然替换', async () => {
    const r = await started()
    r.shell().postMessage(group(1, '主题'))
    r.shell().postMessage(group(2, '主题'))
    await tick()
    expect(r.tweaks.at(-1)?.map((g) => g.id)).toEqual([1])

    r.shell().postMessage({ ...group(1, '主题'), values: { r: 12, t: false } })
    await tick()
    expect(r.tweaks.at(-1)?.map((g) => g.values)).toEqual([{ r: 12, t: false }])
    close(r)
  })

  test('F19 工具条门控与调整面板复位：预览 height / 未 render 都不算 ready，组清零就收起', () => {
    expect(canUseTools(false, false, false)).toBe(false)
    expect(canUseTools(false, true, true)).toBe(false)
    expect(canUseTools(true, true, false)).toBe(false)
    expect(canUseTools(true, false, true)).toBe(false)
    expect(canUseTools(true, true, true)).toBe(true)
    expect(tweakingAfterGroups(true, 0)).toBe(false)
    expect(tweakingAfterGroups(true, 2)).toBe(true)
    expect(tweakingAfterGroups(false, 2)).toBe(false)
  })

  test('F12 调整面板：组数有上限，多出来的不画', async () => {
    const r = await started()
    for (let id = 1; id <= INTELLIGENT_UI_TWEAK_GROUPS_MAX + 2; id++) r.shell().postMessage(group(id))
    await tick()
    expect(r.tweaks.at(-1)).toHaveLength(INTELLIGENT_UI_TWEAK_GROUPS_MAX)
    close(r)
  })
})
