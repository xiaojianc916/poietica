import { describe, expect, test } from 'bun:test'
import type { EngineToolContext, EngineToolSpec } from '@poietica/engine'
import { workspacesContract } from '@poietica/feature-workspaces/contract'
import { AppError } from '@poietica/foundation'
import { tempDir } from '@poietica/test-kit'
import { conversationContract, WIDGET_HTML_MAX } from '../../contract'
import { type ProbeFetch, registerWidgetTool, widgetUrlOf } from '../widget-tool'
import { harness } from './helpers'

/*
 * show_widget（审查 R-18）：Core 这一侧只钉参数校验、url 探活、交回什么。渲染在 UI
 * （widget-bridge.test.ts、widget-presentation.test.ts），外壳与 CSP 在 host（widget-shell.test.ts）。
 */

const BASE = 'http://127.0.0.1:5199'

/** 假的开发服务器：/missing 回 404，/down 连不上，其余 200；记下每次探了哪个地址 */
function devServer(): { readonly fetch: ProbeFetch; readonly probed: string[] } {
  const probed: string[] = []
  return {
    probed,
    fetch: async (url) => {
      probed.push(url)
      const path = new URL(url).pathname
      if (path === '/down') throw new Error('connect ECONNREFUSED 127.0.0.1:5199')
      return { status: path === '/missing' ? 404 : 200, body: null }
    },
  }
}

function tool(fetch: ProbeFetch = devServer().fetch): EngineToolSpec {
  const specs: EngineToolSpec[] = []
  registerWidgetTool({ tools: { register: (spec) => specs.push(spec) }, fetch })
  const found = specs[0]
  if (found === undefined) throw new Error('show_widget 没有注册')
  return found
}

const ctx: EngineToolContext = { cwd: '/work', signal: new AbortController().signal, sessionKey: 'thread-1' }

async function errorOf(promise: Promise<unknown>): Promise<AppError | null> {
  return await promise.then(
    () => null,
    (error: unknown) => error as AppError,
  )
}

describe('show_widget（审查 R-18）', () => {
  test('W1 注册：名字 show_widget、只读审批、中文标签；描述里写明 CDN 白名单与小桥', () => {
    const spec = tool()
    expect(spec.name).toBe('show_widget')
    expect(spec.approval).toBe('read')
    expect(spec.label).toBe('展示组件')
    expect(spec.description).toContain('https://cdn.jsdelivr.net')
    expect(spec.description).toContain('poietica.send')
    expect(spec.description).toContain('--color-text')
  })

  test('W2 html 来源：交回「已显示」，不碰网络', async () => {
    const server = devServer()
    const result = await tool(server.fetch).execute({ title: '输入框三种样式', html: '<button>A</button>' }, ctx)
    expect(server.probed).toEqual([])
    expect(result.text).toBe('Widget "输入框三种样式" is now shown to the user.')
    expect(result.details).toEqual({ source: 'html' })
    expect(result.isError).toBeUndefined()
  })

  test('W3 两种来源都给、都不给、给了空白：invalid_params', async () => {
    const both = await errorOf(tool().execute({ title: 't', html: '<p>x</p>', url: `${BASE}/` }, ctx))
    expect(both?.code).toBe('kernel.invalid_params')
    const none = await errorOf(tool().execute({ title: 't' }, ctx))
    expect(none?.code).toBe('kernel.invalid_params')
    const blank = await errorOf(tool().execute({ title: 't', html: '   ' }, ctx))
    expect(blank?.code).toBe('kernel.invalid_params')
  })

  test('W4 html 超过上限：拒绝，并提示拆分或改用 url', async () => {
    const error = await errorOf(tool().execute({ title: 't', html: 'x'.repeat(WIDGET_HTML_MAX + 1) }, ctx))
    expect(error?.code).toBe('kernel.invalid_params')
    expect(error?.message).toContain('改用 url')
    const fits = await tool().execute({ title: 't', html: 'x'.repeat(WIDGET_HTML_MAX) }, ctx)
    expect(fits.isError).toBeUndefined()
  })

  test('W5 url 只认本机：localhost / 127.0.0.1 的 http(s)，不收别的主机、协议和带口令的地址', () => {
    expect(widgetUrlOf('http://localhost:5173/__preview').href).toBe('http://localhost:5173/__preview')
    expect(widgetUrlOf(' https://127.0.0.1:8443/a ').href).toBe('https://127.0.0.1:8443/a')
    for (const bad of [
      'http://example.com/',
      'http://192.168.1.2:3000/',
      'file:///C:/x.html',
      'javascript:alert(1)',
      'http://user:pw@localhost:3000/',
      'not a url',
    ]) {
      expect(() => widgetUrlOf(bad)).toThrow(AppError)
    }
  })

  test('W6 url 来源：先探一次，页面能打开就交回状态码', async () => {
    const server = devServer()
    const result = await tool(server.fetch).execute({ title: '真实页面', url: `${BASE}/preview` }, ctx)
    expect(server.probed).toEqual([`${BASE}/preview`])
    expect(result.text).toBe(`Widget "真实页面" is now showing ${BASE}/preview (HTTP 200).`)
    expect(result.details).toEqual({ source: 'url', url: `${BASE}/preview` })
  })

  test('W7 url 来源：404 与开发服务器没起来都当场报给模型', async () => {
    const missing = await errorOf(tool().execute({ title: 't', url: `${BASE}/missing` }, ctx))
    expect(missing?.code).toBe('kernel.invalid_params')
    expect(missing?.message).toContain('HTTP 404')
    const down = await errorOf(tool().execute({ title: 't', url: `${BASE}/down` }, ctx))
    expect(down?.code).toBe('kernel.invalid_params')
    expect(down?.message).toContain('开发服务器没有响应')
  })

  test('W8 不是本机的地址：不探，直接拒绝', async () => {
    const server = devServer()
    const error = await errorOf(tool(server.fetch).execute({ title: 't', url: 'http://example.com/' }, ctx))
    expect(error?.code).toBe('kernel.invalid_params')
    expect(server.probed).toEqual([])
  })
})

describe('show_widget 经真内核（审查 R-18）', () => {
  test('M1 conversation 模块装好以后 agent 就能调 show_widget：参数原样记在这次调用上（卡片从这里读）', async () => {
    const dir = await tempDir('show-widget-')
    const html = '<button class="primary" onclick="poietica.send(\'用方案 B\')">用方案 B</button>'
    const { h, engine } = await harness({
      script: () => [{ kind: 'tool', name: 'show_widget', args: { title: '方案对比', html }, result: '' }],
    })
    const ws = await h.client(workspacesContract).call('workspaces.add', { path: dir.path })
    const api = h.client(conversationContract)
    const thread = await api.call('threads.create', { workspaceId: ws.id })
    await api.call('turns.submit', {
      threadId: thread.id,
      clientTurnId: 'T1',
      text: '给我两个方案',
      attachmentIds: [],
      skills: [],
      deliverAs: 'turn',
    })
    for (let i = 0; i < 200 && !engine.toolCalls.some((c) => c.name === 'show_widget'); i++) {
      await h.clock.advanceAsync(20)
      await Bun.sleep(5)
    }
    const call = engine.toolCalls.find((c) => c.name === 'show_widget')
    expect(call?.sessionKey).toBe(thread.id)
    expect(call?.result).toBe('Widget "方案对比" is now shown to the user.')
    await h.dispose()
    await dir.dispose()
  })
})
