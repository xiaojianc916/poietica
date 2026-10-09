import { describe, expect, test } from 'bun:test'
import attachments from '@poietica/feature-attachments/ui'
import conversation from '@poietica/feature-conversation/ui'
import platform from '@poietica/feature-platform/ui'
import preferences from '@poietica/feature-preferences/ui'
import workspaces from '@poietica/feature-workspaces/ui'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import { createUiKernel } from '@poietica/ui-kernel'

/*
 * R-07 U7：conversation 与 attachments 两个 UI 功能一起装载。
 *
 * 这一条钉的是**依赖方向**：草稿引用同步住在 attachments 的 UI（它本来就依赖
 * conversation），conversation 只交出只读视图、不反过来依赖 attachments。
 * 报告原稿的 §3.4 让 conversation 也依赖 attachments，两边一合就是环 ——
 * `sortModules` 会在 start() 时抛 `kernel.module_graph_invalid`。
 */

function statusBridge(): WindowBridge {
  const listeners = new Set<(message: RpcMessage) => void>()
  return {
    send(message: RpcMessage) {
      if ('id' in message && typeof message.id === 'number' && 'method' in message) {
        const id = message.id
        queueMicrotask(() => {
          for (const l of [...listeners]) {
            l({
              jsonrpc: '2.0',
              id,
              result: message.method === 'core.getStatus' ? { state: 'starting', reason: null, attempt: 0 } : {},
            })
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

describe('R-07 草稿引用同步的装配', () => {
  test('U7 conversation 与 attachments 一起装载：不成环，且两边 setup 都成功', async () => {
    const kernel = createUiKernel({
      features: [platform, preferences, workspaces, conversation, attachments],
      errorMessages: {},
      validateResults: false,
      defaultRoute: { surface: 'conversation.home', params: {} },
      bridge: statusBridge(),
    })

    try {
      /* 成环时 sortModules 在这里抛 kernel.module_graph_invalid（setup 失败的错另有出路）。 */
      await kernel.start()
      expect([...kernel.failures.keys()]).toEqual([])
    } finally {
      kernel.dispose()
    }
  })
})
