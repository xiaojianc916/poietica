import { afterEach, describe, expect, test } from 'bun:test'
import attachments from '@poietica/feature-attachments/ui'
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
 * R-04 S12：Core 每次重启都会重跑 onCoreReady，而**读盘**那两步只能做一次。
 *
 * `composer.hydrate` 是 `{...当前, ...盘上}` 的合并：重启那一刻用户输入框里最近
 * 300ms（UI 去抖）+ 500ms（Host 去抖）内敲的字还没落盘，再读一次盘上的旧版本会把
 * 它们覆盖回去（R-04 §1.5）。这一条把「第二次 ready 不再读 draft」钉在装配层，
 * 因为这一段逻辑住在 ui/index.tsx，单测碰不到。
 */

function testBridge(stored: Readonly<Record<string, unknown>> = {}) {
  const listeners = new Set<(m: RpcMessage) => void>()
  const calls: string[] = []
  const reads: string[] = []
  const params: Array<{ readonly method: string; readonly params: unknown }> = []
  const replies: Readonly<Record<string, unknown>> = {
    'core.getStatus': { state: 'ready', reason: null, attempt: 0 },
    'threads.list': { threads: [] },
    'workspaces.list': { workspaces: [] },
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
  const bridge: WindowBridge & {
    calls: readonly string[]
    emit(message: RpcMessage): void
    params: readonly { readonly method: string; readonly params: unknown }[]
    reads: readonly string[]
  } = {
    calls,
    params,
    reads,
    emit(message) {
      for (const listener of [...listeners]) listener(message)
    },
    send(message: RpcMessage) {
      if ('id' in message && typeof message.id === 'number' && 'method' in message) {
        const id = message.id
        calls.push(message.method)
        params.push({ method: message.method, params: message.params })
        let result = replies[message.method] ?? {}
        if (message.method === 'uiState.get') {
          const key = String((message.params as { readonly key?: unknown }).key ?? '')
          reads.push(key)
          if (key in stored) result = { value: stored[key] }
        }
        queueMicrotask(() => {
          for (const listener of [...listeners]) listener({ jsonrpc: '2.0', id, result })
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
  return bridge
}

describe('R-04 Core 换代后的装配行为', () => {
  let root: Root | null = null

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
  })

  test('R-04 S12 第一次 ready 读一次草稿；重启后的 ready 不再读', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const bridge = testBridge()
    const kernel = createUiKernel({
      features: [workbenchFeature, platform, preferences, workspaces, attachments, conversation],
      errorMessages: {},
      validateResults: false,
      defaultRoute: { surface: 'conversation.home', params: {} },
      bridge,
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

    const draftsReads = (): number => bridge.reads.filter((key) => key === 'conversation.drafts').length
    expect(draftsReads()).toBe(1)

    /* 崩溃重启：ready → restarting → ready，onCoreReady 会再跑一次。 */
    await act(async () => {
      bridge.emit({
        jsonrpc: '2.0',
        method: 'core.status',
        params: { state: 'restarting', reason: 'crashed', attempt: 1 },
      })
      bridge.emit({ jsonrpc: '2.0', method: 'core.status', params: { state: 'ready', reason: null, attempt: 1 } })
    })
    await act(async () => {
      await Bun.sleep(0)
    })
    await act(async () => {
      await Bun.sleep(0)
    })

    expect(draftsReads()).toBe(1)
    /* posture 与草稿同一条理由：盘上的记忆只读一次。 */
    expect(bridge.reads.filter((key) => key === 'conversation.permissionPosture').length).toBe(1)
    /*
     * 线程列表是数据、不是记忆：每次 ready 都要重拉（Core 重启后运行态要重新打底）。
     * 首帧一次 + 重启一次。
     */
    expect(bridge.calls.filter((method) => method === 'threads.list').length).toBe(2)
  })
  /*
   * 真实故障（启动时入口页先显示另一条模型、改一次档位才变成自己选的）：入口页挂载时盘上的草稿还没读回来，
   * 拿空草稿向 Core 要了一份兜底控件表并画了出来。钉住「入口页的每一次 controls.draft 都带着盘上的选择」。
   */
  test('入口页在盘上草稿读回之前不要控件表：每次 controls.draft 都带着盘上那条模型', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const picked = { provider: 'workbuddy', id: 'deepseek-v4.1-flash' }
    const bridge = testBridge({
      'conversation.drafts': {
        __new__: { text: '', attachments: [], skills: [], selection: { model: picked, thinking: 'max' } },
      },
    })
    const kernel = createUiKernel({
      features: [workbenchFeature, platform, preferences, workspaces, attachments, conversation],
      errorMessages: {},
      validateResults: false,
      defaultRoute: { surface: 'conversation.home', params: {} },
      bridge,
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
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await Bun.sleep(0)
      })
    }

    /*
     * 问题 1 二期：盘上草稿里那一笔在 Core 就绪后写穿「新对话默认」意图（controls.setDraft），
     * 写成功就从草稿里抹掉 —— 之后的 controls.draft 不再带它，由 Core 从意图里读回同一条模型与档位。
     * 所以要钉的是：写穿之前的每一次读都带着盘上的选择，写穿的正是那一笔，写穿之后草稿不再重复带它。
     */
    const writeAt = bridge.params.findIndex((call) => call.method === 'controls.setDraft')
    expect(writeAt).toBeGreaterThanOrEqual(0)
    expect(bridge.params[writeAt]?.params).toEqual({ model: picked, thinking: 'max', hidden: [] })
    const before = bridge.params.slice(0, writeAt).filter((call) => call.method === 'controls.draft')
    const after = bridge.params.slice(writeAt + 1).filter((call) => call.method === 'controls.draft')
    expect(before.length).toBeGreaterThan(0)
    for (const call of before) {
      expect((call.params as { readonly model: unknown }).model).toEqual(picked)
      expect((call.params as { readonly thinking: unknown }).thinking).toBe('max')
    }
    /* 抹掉草稿会让入口页重读一次：最后那一次不再带本地那一笔 */
    expect(after.at(-1)?.params).toMatchObject({ model: null, thinking: null })
  })
})
