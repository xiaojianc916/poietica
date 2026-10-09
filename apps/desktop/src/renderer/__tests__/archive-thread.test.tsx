import { afterEach, describe, expect, test } from 'bun:test'
import conversation from '@poietica/feature-conversation/ui'
import platform from '@poietica/feature-platform/ui'
import preferences from '@poietica/feature-preferences/ui'
import workspaces from '@poietica/feature-workspaces/ui'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import { createUiKernel, KernelProvider } from '@poietica/ui-kernel'
import { Workbench, workbenchFeature } from '@poietica/workbench'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/*
 * 侧栏行尾那枚「归档」按钮（真机反馈：点了像没反应）。
 *
 * 两条判据：
 *   ① 点完那一行**立刻**从活动列表上消失 —— 契约里 archived 就是「移出活动列表」的记号，
 *      而侧栏原先不读它，照画不误；archived 页签还是靠自己的查询，所以看设置能看出来，
 *      看侧栏看不出来；
 *   ② 横幅出现（legacy assistant-sidebar-panel 的两条动作：撤销 / 筛选已归档会话），
 *      撤销把那条放回列表。
 *
 * 装配 conversation 与它声明的三个依赖，不把全部功能拉进来 —— 要钉的是侧栏那一段，
 * 它与 thread-list-selector 同一条装配路径。
 */

const THREAD = {
  id: 't-1',
  workspaceId: 'w-1',
  title: '你好',
  titleSource: 'auto',
  posture: 'auto-edit',
  origin: 'user',
  state: 'idle',
  hasSession: true,
  forkedFrom: null,
  pinned: false,
  archived: false,
  createdAt: 1_791_300_000_000,
  updatedAt: 1_791_300_000_000,
}

const WORKSPACE = {
  id: 'w-1',
  name: 'poietica',
  path: 'D:/xiaojianc/poietica',
  kind: 'folder',
  createdAt: 1_791_300_000_000,
}

const calls: Array<{ method: string; params: unknown }> = []

function testBridge(): WindowBridge {
  const listeners = new Set<(m: RpcMessage) => void>()
  calls.length = 0
  const replies: Readonly<Record<string, unknown>> = {
    'core.getStatus': { state: 'ready', reason: null, attempt: 0 },
    'threads.list': { threads: [THREAD] },
    'workspaces.list': { workspaces: [WORKSPACE] },
    'keymap.get': { overrides: {} },
    'uiState.get': { value: null },
    'prefs.get': {
      theme: 'system',
      language: 'zh-CN',
      logLevel: 'info',
      general: { sendWithModifier: false, confirmBeforeDelete: true, notifyOnCompletion: true },
      appearance: { density: 'comfortable', reduceMotion: false, messageTimestamps: false },
      modelPicker: { hiddenModels: [], providerOrder: [] },
      updates: { autoCheck: true },
    },
  }
  return {
    send(message: RpcMessage) {
      if ('id' in message && typeof message.id === 'number' && 'method' in message) {
        const id = message.id
        calls.push({ method: message.method as string, params: message.params })
        /* 归档 / 撤销的回话是**请求里的那一档**（契约实体，archived 跟着走）。 */
        const result =
          message.method === 'threads.setArchived'
            ? { ...THREAD, archived: (message.params as { archived: boolean }).archived }
            : (replies[message.method as string] ?? {})
        queueMicrotask(() => {
          for (const l of [...listeners]) l({ jsonrpc: '2.0', id, result })
        })
      }
    },
    onMessage(listener: (message: RpcMessage) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    pathForFile: () => 'C:/tmp/x',
  }
}

describe('侧栏 · 归档', () => {
  let root: Root | null = null

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
  })

  async function mount(): Promise<HTMLElement> {
    const host = document.createElement('div')
    document.body.append(host)
    const kernel = createUiKernel({
      features: [workbenchFeature, platform, preferences, workspaces, conversation],
      errorMessages: {},
      validateResults: false,
      defaultRoute: { surface: 'conversation.home', params: {} },
      bridge: testBridge(),
    })
    await kernel.start()
    root = createRoot(host)
    await act(async () => {
      root?.render(
        <KernelProvider kernel={kernel}>
          <Workbench />
        </KernelProvider>,
      )
    })
    await act(async () => {
      await Bun.sleep(0)
    })
    await act(async () => {
      await Bun.sleep(0)
    })
    return host
  }

  test('点归档：那一行立刻离开列表，并出现带「撤销」的横幅', async () => {
    const host = await mount()
    expect(host.textContent ?? '').toContain('你好')

    calls.length = 0
    const archive = host.querySelector<HTMLButtonElement>('button[aria-label="归档"]')
    expect(archive).not.toBeNull()
    await act(async () => {
      archive?.click()
    })
    await act(async () => {
      await Bun.sleep(0)
    })

    const call = calls.find((c) => c.method === 'threads.setArchived')
    expect(call?.params).toEqual({ threadId: THREAD.id, archived: true })

    /* ① 侧栏那一行当场消失（没有第二次 threads.list 兜底，这是判据的全部）。 */
    expect(host.textContent ?? '').not.toContain('你好')

    /* ② 横幅：legacy 的两条动作一字未改，动作本身可点。 */
    const banner = document.body.querySelector('.ui-banner')
    expect(banner?.textContent ?? '').toContain('会话已归档，可')
    expect(banner?.textContent ?? '').toContain('撤销')
    expect(banner?.textContent ?? '').toContain('筛选已归档会话')
  })

  test('横幅上的「撤销」把那条放回列表，走 setArchived(id,false)', async () => {
    const host = await mount()
    const archive = host.querySelector<HTMLButtonElement>('button[aria-label="归档"]')
    await act(async () => {
      archive?.click()
    })
    await act(async () => {
      await Bun.sleep(0)
    })
    expect(host.textContent ?? '').not.toContain('你好')

    calls.length = 0
    const undo = [...document.body.querySelectorAll('button')].find((b) => (b.textContent ?? '') === '撤销')
    expect(undo).toBeDefined()
    await act(async () => {
      undo?.click()
    })
    await act(async () => {
      await Bun.sleep(0)
    })

    const call = calls.find((c) => c.method === 'threads.setArchived')
    expect(call?.params).toEqual({ threadId: THREAD.id, archived: false })

    /* 放回去之后就回到列表上（存档页那条「取消归档」是同一件事）。 */
    expect(host.textContent ?? '').toContain('你好')
  })
})
