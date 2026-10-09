import { describe, expect, test } from 'bun:test'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import { createUiKernel, defineUiFeature, KernelProvider, type UiKernel } from '@poietica/ui-kernel'
import { act, renderHook } from '@testing-library/react'
import { type ReactNode, StrictMode } from 'react'
import type { ComposerToolkit, ComposerToolkitSource } from '../../ui-api'
import { composerToolkitSources } from '../../ui-api'
import { useAgentToolkit } from '../configuration/composer-toolkit'

/*
 * useAgentToolkit 这一层：一个真的内核 + 一台假来源，验「谁给的数据、什么时候去要」。
 *
 * 三条判据各自对着一个真实缺陷的形状：
   - 没有任何来源 → 空名册（分组隐藏，而不是崩）；
   - 来源在列 → 两组上屏，且切换工作区会 ensure（技能按项目分层）；
   - 数据没变 → 重渲染不换对象（getSnapshot 引用稳定，否则输入框会自喂自渲）。
 */

/**
 * 假 bridge：只回 `core.getStatus`（内核 start 要它才走得完），其余一概不管 ——
 * 这一份测试不经过别的 RPC。
 */
function statusBridge(): WindowBridge {
  const listeners = new Set<(message: RpcMessage) => void>()
  return {
    send: (message: RpcMessage) => {
      if (
        'id' in message &&
        typeof message.id === 'number' &&
        'method' in message &&
        message.method === 'core.getStatus'
      ) {
        const id = message.id

        queueMicrotask(() => {
          for (const listener of [...listeners]) {
            listener({ jsonrpc: '2.0', id, result: { state: 'ready', reason: null, attempt: 0 } })
          }
        })
      }
    },
    onMessage: (listener: (message: RpcMessage) => void) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    pathForFile: () => 'C:/tmp/x',
  } satisfies WindowBridge
}

async function startKernel(features: Parameters<typeof createUiKernel>[0]['features']): Promise<UiKernel> {
  const kernel = createUiKernel({
    features,
    errorMessages: {},
    validateResults: false,
    defaultRoute: { surface: 'conversation.home', params: {} },
    bridge: statusBridge(),
  })
  await kernel.start()
  return kernel
}

/** 一台可推的假来源：测试自己决定它此刻握着哪一份，以及被 ensure 过哪几个工作区。 */
function fakeSource(initial: ComposerToolkit): ComposerToolkitSource & {
  readonly ensured: Array<string | null>
  put(next: ComposerToolkit): void
} {
  const ensured: Array<string | null> = []
  const listeners = new Set<() => void>()
  let held = initial

  return {
    id: 'test.source',
    ensured,
    ensure: (workspaceId) => {
      ensured.push(workspaceId)
    },
    read: () => held,
    subscribe: (listener) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    put: (next) => {
      held = next

      for (const listener of [...listeners]) {
        listener()
      }
    },
  }
}

const empty: ComposerToolkit = { skills: [], mcpServers: [] }

describe('useAgentToolkit', () => {
  test('没有任何来源 → 空名册', async () => {
    const kernel = await startKernel([])

    const { result, unmount } = renderHook(() => useAgentToolkit('w-1'), {
      wrapper: ({ children }: { readonly children: ReactNode }) => (
        <KernelProvider kernel={kernel}>{children}</KernelProvider>
      ),
    })

    expect(result.current.skills).toHaveLength(0)
    expect(result.current.mcpServers).toHaveLength(0)
    unmount()
  })

  test('来源在列 → 两组上屏；换工作区再要一次', async () => {
    const source = fakeSource({
      skills: [{ name: '翻译', description: '翻一下', source: 'user' }],
      mcpServers: [{ name: 'github', state: 'connected', toolCount: 3, error: null }],
    })
    const provider = defineUiFeature({
      id: 'test-provider',
      setup: (ctx) => {
        ctx.contribute(composerToolkitSources, source)
      },
    })
    const kernel = await startKernel([provider])

    const { result, rerender, unmount } = renderHook(
      ({ workspaceId }: { readonly workspaceId: string | null }) => useAgentToolkit(workspaceId),
      {
        initialProps: { workspaceId: 'w-1' as string | null },
        wrapper: ({ children }: { readonly children: ReactNode }) => (
          <KernelProvider kernel={kernel}>{children}</KernelProvider>
        ),
      },
    )

    expect(result.current.skills.map((row) => row.name)).toEqual(['翻译'])
    expect(result.current.mcpServers.map((row) => row.name)).toEqual(['github'])
    expect(result.current.mcpServers[0]?.status).toBe('connected')
    expect(source.ensured).toEqual(['w-1'])

    rerender({ workspaceId: 'w-2' })

    expect(source.ensured).toEqual(['w-1', 'w-2'])
    unmount()
  })

  test('数据没变 → 重渲染交回同一个对象；来源推新数据才换', async () => {
    const held: ComposerToolkit = { skills: [{ name: '翻译', description: '', source: 'user' }], mcpServers: [] }
    const source = fakeSource(held)
    const provider = defineUiFeature({
      id: 'test-provider',
      setup: (ctx) => {
        ctx.contribute(composerToolkitSources, source)
      },
    })
    const kernel = await startKernel([provider])

    const { result, rerender, unmount } = renderHook(() => useAgentToolkit('w-1'), {
      wrapper: ({ children }: { readonly children: ReactNode }) => (
        <KernelProvider kernel={kernel}>{children}</KernelProvider>
      ),
    })
    const first = result.current

    rerender()

    /* 来源对象没换：合并结果必须是**同一个**引用（getSnapshot 的判据）。 */
    expect(result.current).toBe(first)

    await act(async () => {
      source.put({ skills: [...held.skills, { name: '总结', description: '', source: 'user' }], mcpServers: [] })
    })

    expect(result.current).not.toBe(first)
    expect(result.current.skills.map((row) => row.name)).toEqual(['翻译', '总结'])
    unmount()
  })

  test('StrictMode 的双渲染不会把 ensure 发两遍之外再发一遍别的', async () => {
    const source = fakeSource(empty)
    const provider = defineUiFeature({
      id: 'test-provider',
      setup: (ctx) => {
        ctx.contribute(composerToolkitSources, source)
      },
    })
    const kernel = await startKernel([provider])

    const { unmount } = renderHook(() => useAgentToolkit('w-1'), {
      wrapper: ({ children }: { readonly children: ReactNode }) => (
        <StrictMode>
          <KernelProvider kernel={kernel}>{children}</KernelProvider>
        </StrictMode>
      ),
    })

    /* StrictMode 会把 effect 跑两遍，但两次要的都是同一个工作区。 */
    expect(new Set(source.ensured)).toEqual(new Set(['w-1']))
    unmount()
  })
})
