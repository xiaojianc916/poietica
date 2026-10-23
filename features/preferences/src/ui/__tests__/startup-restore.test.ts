import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createUiKernel, defineUiFeature, type UiFeature, type UiKernel } from '@poietica/ui-kernel'
import { Preferences } from '../../contract/entities'
import { PreferencesToken, type UiStateSlot } from '../../ui-api'
import preferencesFeature, { routeOf } from '../index'

/* preferences 不依赖 @poietica/rpc（依赖隔离）：桥的类型从 createUiKernel 的入参里取。 */
type WindowBridge = NonNullable<Parameters<typeof createUiKernel>[0]['bridge']>
type RpcMessage = Parameters<WindowBridge['send']>[0]

/*
 * R-19-2 / R-19-3：主题与布局都住在 Host，不该等 Core。
 *
 * 这里的 Core 永远停在 starting（冷启动最慢的那一段）：
 * - 存下的布局必须在 kernel.start 返回时（= 第一次渲染之前）就已经恢复；
 * - 恢复完成之后、Core 就绪之前改的布局也要写回；
 * - prefs.get 迟迟不回时，文档根上也已经有主题（取渲染层此刻的 prefers-color-scheme，Host 已按偏好设好）。
 */

interface Wire {
  readonly bridge: WindowBridge
  readonly sent: { readonly method: string; readonly params: unknown }[]
}

/** 按方法名应答的最小 bridge，按发送顺序逐条应答；`hang` 里的方法永不应答。 */
function wire(
  answers: Record<string, (params: Record<string, unknown>) => unknown>,
  hang: readonly string[] = [],
): Wire {
  const listeners = new Set<(message: RpcMessage) => void>()
  const sent: { method: string; params: unknown }[] = []
  return {
    sent,
    bridge: {
      send(message) {
        if (!('method' in message)) return
        sent.push({ method: message.method, params: message.params })
        if (!('id' in message) || typeof message.id !== 'number' || hang.includes(message.method)) return
        const id = message.id
        const answer = answers[message.method]
        const result = answer === undefined ? {} : answer((message.params ?? {}) as Record<string, unknown>)
        /*
         * 每条应答一个宏任务：与 Electron IPC 相同（一条消息一个任务，前一条应答的微任务链先跑完）。
         * 用 Bun.sleep 不用 setTimeout：测试环境里 setTimeout 是 happy-dom 的，同一时刻到期的几个回调会连着跑、中间不清微任务。
         */
        void Bun.sleep(0).then(() => {
          for (const listener of [...listeners]) listener({ jsonrpc: '2.0', id, result })
        })
      },
      onMessage(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      pathForFile: () => 'C:/tmp/x',
    },
  }
}

const STARTING = { state: 'starting', reason: null, attempt: 0 }
const SAVED_LAYOUT = { sidebar: { visible: false, width: 320 } }
const SAVED_ROUTE = { surface: 'conversation.thread', params: { threadId: 't1' } }

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

let kernel: UiKernel | null = null
const realMatchMedia = window.matchMedia

function boot(w: Wire, extra: readonly UiFeature[] = []): Promise<void> {
  kernel = createUiKernel({
    features: [preferencesFeature, ...extra],
    errorMessages: {},
    validateResults: false,
    defaultRoute: { surface: 'home', params: {} },
    bridge: w.bridge,
  })
  return kernel.start()
}

beforeEach(() => {
  delete document.documentElement.dataset.theme
})

afterEach(() => {
  kernel?.dispose()
  kernel = null
  window.matchMedia = realMatchMedia
})

describe('启动恢复不等 Core（R-19-2 / R-19-3）', () => {
  test('存下的布局在 kernel.start 返回时已经恢复，且恢复本身不写回', async () => {
    const w = wire({
      'core.getStatus': () => STARTING,
      'prefs.get': () => Preferences.parse({}),
      'uiState.get': (p) => ({ value: p.key === 'layout' ? SAVED_LAYOUT : null }),
    })
    await boot(w)

    expect(kernel?.kernelServices.layout.current().sidebar).toEqual({ visible: false, width: 320 })
    expect(w.sent.filter((m) => m.method === 'uiState.set')).toEqual([])
  })

  test('恢复之后、Core 就绪之前开合侧栏：照样写回', async () => {
    const w = wire({
      'core.getStatus': () => STARTING,
      'prefs.get': () => Preferences.parse({}),
      'uiState.get': (p) => ({ value: p.key === 'layout' ? SAVED_LAYOUT : null }),
    })
    await boot(w)
    await flush()

    kernel?.kernelServices.layout.toggleSidebar()

    const writes = w.sent.filter((m) => m.method === 'uiState.set')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.params).toMatchObject({ key: 'layout', value: { sidebar: { visible: true, width: 320 } } })
    /* 等这条写回的应答到了再收摊：dispose 会把在途请求全部拒掉 */
    await Bun.sleep(1)
  })

  test('prefs.get 迟迟不回：文档根上已经是渲染层此刻的那一档主题', async () => {
    window.matchMedia = ((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia
    const w = wire({ 'core.getStatus': () => STARTING, 'uiState.get': () => ({ value: null }) }, ['prefs.get'])
    await boot(w)

    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})

/*
 * 重开软件先闪一下「新建对话」再跳回上次那条对话：路由恢复以前排在 onCoreReady 里，冷启动这几秒外壳按 defaultRoute 画。
 * 路由与布局同住 Host 的 uiState，同一条规则 —— 第一次渲染之前就恢复，不等 Core。
 */
describe('启动时上次那一页不等 Core', () => {
  test('存下的路由在 kernel.start 返回时已经恢复：不进历史、不写回', async () => {
    const w = wire({
      'core.getStatus': () => STARTING,
      'prefs.get': () => Preferences.parse({}),
      'uiState.get': (p) => ({ value: p.key === 'navigation' ? SAVED_ROUTE : null }),
    })
    await boot(w)

    expect(kernel?.kernelServices.navigation.current()).toEqual({
      route: SAVED_ROUTE,
      canGoBack: false,
      canGoForward: false,
    })
    expect(w.sent.filter((m) => m.method === 'uiState.set')).toEqual([])
  })

  test('恢复之后、Core 就绪之前换了一页：照样写回', async () => {
    const w = wire({
      'core.getStatus': () => STARTING,
      'prefs.get': () => Preferences.parse({}),
      'uiState.get': (p) => ({ value: p.key === 'navigation' ? SAVED_ROUTE : null }),
    })
    await boot(w)
    await flush()

    const next = { surface: 'conversation.thread', params: { threadId: 't2' } }
    kernel?.kernelServices.navigation.navigate(next)

    const writes = w.sent.filter((m) => m.method === 'uiState.set')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.params).toMatchObject({ key: 'navigation', value: next })
    await Bun.sleep(1)
  })

  test('存下的值形状不对：留在 defaultRoute', async () => {
    const w = wire({
      'core.getStatus': () => STARTING,
      'prefs.get': () => Preferences.parse({}),
      'uiState.get': (p) => ({ value: p.key === 'navigation' ? { surface: 42, params: {} } : null }),
    })
    await boot(w)

    expect(kernel?.kernelServices.navigation.current().route).toEqual({ surface: 'home', params: {} })
  })

  test('routeOf 只收 { surface: 非空串, params: 串值对象 }', () => {
    expect(routeOf(SAVED_ROUTE)).toEqual(SAVED_ROUTE)
    expect(routeOf(null)).toBeNull()
    expect(routeOf({ surface: '', params: {} })).toBeNull()
    expect(routeOf({ surface: 'a', params: [] })).toBeNull()
    expect(routeOf({ surface: 'a', params: { n: 1 } })).toBeNull()
    expect(routeOf({ surface: 'a' })).toBeNull()
  })
})

/*
 * 别的功能在 setup 里开的 uiState 槽（批准方式、草稿走的就是这一条）同样在首帧之前恢复。
 * 批准方式以前排在首次 onCoreReady 里读：冷启动这几秒入口页按默认档画，Core 一就绪再跳成存下的那一档。
 */
describe('其它功能的 setup 阶段键也不等 Core', () => {
  test('setup 里开的槽：kernel.start 返回时已经恢复，且恢复本身不写回', async () => {
    const memory: { held: string | null } = { held: null }
    let slot: UiStateSlot | null = null
    const probe = defineUiFeature({
      id: 'probe',
      dependsOn: ['preferences'],
      setup(ctx) {
        slot = ctx.services.get(PreferencesToken).uiStateSlot({
          key: 'conversation.permissionPosture',
          parse: (stored) => (typeof stored === 'string' ? stored : null),
          restore: (value) => {
            memory.held = value
          },
          snapshot: () => memory.held,
          subscribe: () => () => undefined,
          readFailure: 'release',
        })
      },
    })
    const w = wire({
      'core.getStatus': () => STARTING,
      'prefs.get': () => Preferences.parse({}),
      'uiState.get': (p) => ({ value: p.key === 'conversation.permissionPosture' ? 'full-access' : null }),
    })
    await boot(w, [probe])

    expect(memory.held).toBe('full-access')
    expect((slot as UiStateSlot | null)?.restored()).toBe(true)
    expect(w.sent.filter((m) => m.method === 'uiState.set')).toEqual([])
  })
})
