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
 * 这一条钉的是**依赖方向**：conversation → attachments（与 Core 同向，见 tooling/depcruise/feature-tiers.json），
 * attachments 不认识 conversation。草稿引用同步由 conversation 把只读视图交给 attachments 的 `trackDraftRefs`，
 * 正是报告原稿 §3.4 的接法；当初它与「attachments → conversation」的旧方向一合就是环，才临时反过来放。
 * 方向再被翻回去时，`sortModules` 会在 start() 时抛 `kernel.module_graph_invalid`。
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
      features: [platform, preferences, workspaces, attachments, conversation],
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
