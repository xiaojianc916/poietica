import { describe, expect, test } from 'bun:test'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import { waitFor } from '@poietica/test-kit'
import { createUiKernel, defineUiFeature } from '@poietica/ui-kernel'
import type { Workspace } from '../../contract'
import { type WorkspacesUi, WorkspacesUiToken } from '../../ui-api'
import workspaces from '../index'

const first: Workspace = { id: 'one', path: 'C:/one', name: '一', createdAt: 0, lastOpenedAt: 0, exists: true }
const second: Workspace = { ...first, id: 'two', path: 'C:/two', name: '二' }

function bridge(items: readonly Workspace[]): WindowBridge {
  const listeners = new Set<(message: RpcMessage) => void>()
  return {
    send(message) {
      if (!('id' in message) || typeof message.id !== 'number' || !('method' in message)) return
      const result =
        message.method === 'core.getStatus'
          ? { state: 'ready', reason: null, attempt: 0 }
          : message.method === 'workspaces.list'
            ? { workspaces: items }
            : {}
      queueMicrotask(() => {
        for (const listener of [...listeners]) listener({ jsonrpc: '2.0', id: message.id as number, result })
      })
    },
    onMessage(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    pathForFile: () => 'C:/unused',
  }
}

async function boot(items: readonly Workspace[]) {
  let service: WorkspacesUi | undefined
  const consumer = defineUiFeature({
    id: 'consumer',
    dependsOn: ['workspaces'],
    setup(ctx) {
      service = ctx.services.get(WorkspacesUiToken)
    },
  })
  const kernel = createUiKernel({
    features: [defineUiFeature({ id: 'platform', setup: () => undefined }), workspaces, consumer],
    errorMessages: {},
    validateResults: false,
    defaultRoute: { surface: 'home', params: {} },
    bridge: bridge(items),
  })
  await kernel.start()
  await waitFor(() => service?.store.getState().items.length === items.length)
  expect([...kernel.failures.keys()]).toEqual([])
  if (service === undefined) throw new Error('WorkspacesUiToken 没有提供')
  return { kernel, service }
}

describe('WorkspacesUiToken', () => {
  test('真实 store 在异步名单到达后通知，当前项与 active 同源', async () => {
    const { kernel, service } = await boot([first, second])
    try {
      expect(service.store.getState()).toEqual({ items: [first, second], activeId: 'one' })
      expect(service.active()).toEqual(first)
      const observed: (Workspace | null)[] = []
      const off = service.subscribeActive((workspace) => {
        observed.push(workspace)
      })
      service.setActive('two')
      expect(observed).toEqual([second])
      expect(service.store.getState().activeId).toBe('two')
      expect(service.store.getInitialState()).toEqual({ items: [], activeId: null })
      off()
      await Bun.sleep(0)
    } finally {
      kernel.dispose()
    }
  })

  test('删除后重读不替用户补选已失效的当前项', async () => {
    const { kernel, service } = await boot([first])
    try {
      service.setActive('missing')
      await service.remove('missing')
      expect(service.store.getState()).toEqual({ items: [first], activeId: null })
      expect(service.active()).toBeNull()
    } finally {
      kernel.dispose()
    }
  })
})
