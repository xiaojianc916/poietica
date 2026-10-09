import { describe, expect, test } from 'bun:test'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import { createUiKernel, KernelProvider } from '@poietica/ui-kernel'
import { Workbench, workbenchFeature } from '@poietica/workbench'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { uiFeatures } from '../features'

/*
 * 假 bridge：**按方法回话**。
 *
 * 早先它对任何方法都回同一个 Core 状态对象，于是每个「读一次配置」的功能都拿到一份
 * 没有自己字段的载荷（真实踩到过两次：preferences 的 appearance、conversation 的
 * controls.defaults）。这条测试要验的是「首屏装配得起来、主区有内容」，所以除
 * core.getStatus 之外一律回空对象 —— 各功能自己的空态就是它们要处理的第一帧。
 */
function testBridge(): WindowBridge {
  const listeners = new Set<(m: RpcMessage) => void>()
  const CORE_STATUS = { state: 'starting', reason: null, attempt: 0 }
  return {
    send(message: RpcMessage) {
      if ('id' in message && typeof message.id === 'number' && 'method' in message) {
        const id = message.id
        const result = message.method === 'core.getStatus' ? CORE_STATUS : {}
        queueMicrotask(() => {
          for (const l of [...listeners]) {
            l({ jsonrpc: '2.0', id, result })
          }
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

describe('渲染层冒烟', () => {
  test('首屏与全部功能装配后主区有内容', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    let root: Root | null = null

    try {
      const kernel = createUiKernel({
        features: [workbenchFeature, ...uiFeatures],
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

      const main = host.querySelector('[data-workbench-part="main"]')
      expect(main).not.toBeNull()
      expect(main?.textContent ?? '').not.toBe('')
      expect(host.querySelector('[data-feature-error]')).toBeNull()
    } finally {
      await act(async () => {
        root?.unmount()
      })
      host.remove()
    }
  })
})
