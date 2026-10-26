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

test('Core 换代：旧名单的迟到响应不能覆盖新一代状态', async () => {
  const listeners = new Set<(message: RpcMessage) => void>()
  const pending: number[] = []
  const emit = (message: RpcMessage): void => {
    for (const listener of [...listeners]) listener(message)
  }
  const controlled: WindowBridge = {
    send(message) {
      if (!('id' in message) || typeof message.id !== 'number' || !('method' in message)) return
      if (message.method === 'workspaces.list') pending.push(message.id)
      else queueMicrotask(() => emit({ jsonrpc: '2.0', id: message.id as number, result: { state: 'ready' } }))
    },
    onMessage(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    pathForFile: () => 'C:/unused',
  }
  let service: WorkspacesUi | undefined
  const kernel = createUiKernel({
    features: [
      defineUiFeature({ id: 'platform', setup: () => undefined }),
      workspaces,
      defineUiFeature({
        id: 'consumer',
        dependsOn: ['workspaces'],
        setup(ctx) {
          service = ctx.services.get(WorkspacesUiToken)
        },
      }),
    ],
    bridge: controlled,
    errorMessages: {},
    validateResults: false,
    defaultRoute: { surface: 'home', params: {} },
  })
  try {
    await kernel.start()
    emit({ jsonrpc: '2.0', method: 'core.status', params: { state: 'restarting' } })
    emit({ jsonrpc: '2.0', method: 'core.status', params: { state: 'ready' } })
    expect(pending.length).toBe(2)
    emit({ jsonrpc: '2.0', id: pending[1]!, result: { workspaces: [second] } })
    await waitFor(() => service?.store.getState().items[0]?.id === 'two')
    emit({ jsonrpc: '2.0', id: pending[0]!, result: { workspaces: [first] } })
    await Bun.sleep(0)
    expect(service?.store.getState().items).toEqual([second])
  } finally {
    kernel.dispose()
  }
})
