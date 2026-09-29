import { expect, mock, test } from 'bun:test'
import type { PluginStore } from '@poietica/extension'

/* 端点是原生侧问出来的；这里只替换那一个模块，其余判据走真代码。 */
mock.module('@poietica/native-bridge/browser', () => ({
  browserDevtoolsEndpoint: () => Promise.resolve(ENDPOINT),
}))

/* 探活也要能钉住：真去连端口会让测试依赖机器上恰好有没有东西在听。 */
const listening = new Set<number>()
mock.module('./browser-endpoint-probe', () => ({
  isAlive: (endpoint: string) => Promise.resolve(listening.has(Number(URL.parse(endpoint)?.port))),
}))

const { alignBrowserEndpoint } = await import('./browser-endpoint')

const ENDPOINT = 'http://127.0.0.1:54915'

interface Harness {
  readonly store: PluginStore
  readonly written: readonly string[]
  readonly retired: readonly (string | null)[]
}

function harness(cdpUrl: string | null): Harness {
  const written: string[] = []
  const retired: (string | null)[] = []
  const store = {
    getSnapshot: () => ({
      browser: { kind: 'ready', enabled: true, headless: true, cdpUrl, appEndpoint: null },
    }),
    setBrowserSettings: (patch: { cdpUrl?: string }) => {
      if (patch.cdpUrl !== undefined) {
        written.push(patch.cdpUrl)
      }
    },
    reconcileHostedServer: (_name: string, body: Record<string, unknown> | null) => {
      retired.push(body === null ? null : 'body')

      return Promise.resolve()
    },
  }

  return { store: store as unknown as PluginStore, written, retired }
}

test('a dead app endpoint left over from a previous run is realigned', async () => {
  /* 上一趟的端口随进程一起没了：留着等于让 agent 连一个没人听的地址。 */
  const { store, written } = harness('http://127.0.0.1:54138')
  await alignBrowserEndpoint(store)
  expect(written).toEqual([ENDPOINT])
})

test('an endpoint that is already current is left alone', async () => {
  const { store, written } = harness(ENDPOINT)
  await alignBrowserEndpoint(store)
  expect(written).toEqual([])
})

test('the managed browser is never given an endpoint', async () => {
  /* 托管那一档由 agent 自己拉浏览器，这里不认识任何端点。 */
  const { store, written } = harness(null)
  await alignBrowserEndpoint(store)
  expect(written).toEqual([])
})

test('a live user-picked browser is never taken over', async () => {
  /* 用户选的现成浏览器按定义在跑：探活通过就不碰它，哪怕它也是本机回环。 */
  listening.add(9222)
  const { store, written } = harness('http://127.0.0.1:9222')
  await alignBrowserEndpoint(store)
  listening.clear()
  expect(written).toEqual([])
})

test('a stale user-picked browser that is no longer running is realigned', async () => {
  /* 端口没人听了，那一档就已经名存实亡；对齐到内置端点比让 agent 对着死端口有用。 */
  const { store, written } = harness('http://127.0.0.1:9222')
  await alignBrowserEndpoint(store)
  expect(written).toEqual([ENDPOINT])
})

test('a CDP endpoint that cannot be parsed is not treated as alive', async () => {
  /* 形状不对的地址不该被当成「用户的选择」而挡住对齐。 */
  const { store, written } = harness('not a url')
  await alignBrowserEndpoint(store)
  expect(written).toEqual([ENDPOINT])
})

test('the retired browser MCP entry is removed on every start', async () => {
  const { store, retired } = harness(null)
  await alignBrowserEndpoint(store)
  /* 幂等：本来就没有也照发一次 null，删除路径自己早退。 */
  expect(retired).toEqual([null])
})
