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
 * 设置里的「已归档」页（conversation 贡献，07 页没给落点 → 按产品负责人 2026-10-07
 * 的指示补进 conversation 的 ui，逐字迁移 legacy 的 ArchivedChatsSettings）。
 *
 * 装配 conversation + 它声明的依赖（workspaces / preferences / platform），与
 * thread-list-selector 同一个判据：要钉的是**装配层真的注册了这一页**，
 * 而 page 组件本身住在 conversation 的 ui 里。
 *
 * 钉三件事：
 *   ① 导航里出现「已归档」一格，且它在 agent 段、位于「用量」之后（legacy 的相对次序）；
 *   ② 这一页列出已归档的聊天（`threads.list({includeArchived:true})` 的结果里 archived=true 的那些）；
 *   ③ 「取消归档」调的是 `threads.setArchived(id,false)`，不是删除。
 */

const ARCHIVED_THREAD = {
  id: 't-archived',
  workspaceId: 'w-1',
  title: '归档过的对话',
  titleSource: 'auto',
  posture: 'auto-edit',
  origin: 'user',
  state: 'idle',
  pendingInteraction: null,
  hasSession: true,
  forkedFrom: null,
  pinned: false,
  archived: true,
  createdAt: 1_791_300_000_000,
  updatedAt: 1_791_300_000_000,
}

const ACTIVE_THREAD = { ...ARCHIVED_THREAD, id: 't-active', title: '活动中的对话', archived: false }

const WORKSPACE = {
  id: 'w-1',
  name: 'poietica',
  path: 'D:/xiaojianc/poietica',
  kind: 'folder',
  createdAt: 1_791_300_000_000,
  lastOpenedAt: 1_791_300_000_000,
  exists: true,
}

const calls: Array<{ method: string; params: unknown }> = []

/** 按方法回错误（JSON-RPC error 对象里带 AppError 的 code / message，与 rpc peer 的 toErrorObject 同形） */
let failures: Readonly<Record<string, { readonly code: string; readonly message: string }>> = {}

function testBridge(): WindowBridge {
  const listeners = new Set<(m: RpcMessage) => void>()
  calls.length = 0
  const replies: Readonly<Record<string, unknown>> = {
    'core.getStatus': { state: 'ready', reason: null, attempt: 0 },
    /* 归档页按 includeArchived:true 拉一份，自己筛 archived（活动列表那条路不带归档）。 */
    'threads.list': { threads: [ARCHIVED_THREAD, ACTIVE_THREAD] },
    'threads.setArchived': { ...ARCHIVED_THREAD, archived: false },
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
        const failure = failures[message.method as string]
        const result = replies[message.method as string] ?? {}
        queueMicrotask(() => {
          for (const l of [...listeners]) {
            l(
              failure === undefined
                ? { jsonrpc: '2.0', id, result }
                : { jsonrpc: '2.0', id, error: { code: -32000, message: failure.message, data: failure } },
            )
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

describe('设置 · 已归档页', () => {
  let root: Root | null = null

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
    failures = {}
  })

  async function mountSettings(): Promise<{ host: HTMLElement; nav: { navigate: (r: unknown) => void } }> {
    const host = document.createElement('div')
    document.body.append(host)
    const kernel = createUiKernel({
      features: [workbenchFeature, platform, preferences, workspaces, attachments, conversation],
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
    return { host, nav: kernel.kernelServices.navigation as unknown as { navigate: (r: unknown) => void } }
  }

  test('导航里有「已归档」，且只列已归档的聊天', async () => {
    const { host, nav } = await mountSettings()
    await act(async () => {
      nav.navigate({ surface: 'workbench.settings', params: { page: 'conversation.archived' } })
    })
    await act(async () => {
      await Bun.sleep(0)
    })
    await act(async () => {
      await Bun.sleep(0)
    })

    const navButton = host.querySelector('[data-settings-page="conversation.archived"]')
    expect(navButton).not.toBeNull()
    expect(navButton?.textContent ?? '').toContain('已归档')

    /*
     * 段归属：已归档在 **agent 段**（与快捷键同段），不在 app 段（通用 / 外观那一段）。
     * 判据用同一批已装配的页：快捷键也是 agent 段，通用是 app 段。
     */
    const archivedSection = navButton?.closest('.settings-navigation__items')
    const keymapSection = host
      .querySelector('[data-settings-page="preferences.keymap"]')
      ?.closest('.settings-navigation__items')
    const generalSection = host
      .querySelector('[data-settings-page="preferences.general"]')
      ?.closest('.settings-navigation__items')
    expect(archivedSection).not.toBeNull()
    expect(archivedSection).toBe(keymapSection)
    expect(archivedSection).not.toBe(generalSection)

    /* 只有 archived=true 的那一条画出来；活动中的那一条不在这页上。 */
    expect(host.textContent ?? '').toContain('归档过的对话')
    expect(host.textContent ?? '').not.toContain('活动中的对话')
  })

  test('「取消归档」调 threads.setArchived(id,false)', async () => {
    const { host, nav } = await mountSettings()
    await act(async () => {
      nav.navigate({ surface: 'workbench.settings', params: { page: 'conversation.archived' } })
    })
    await act(async () => {
      await Bun.sleep(0)
    })
    await act(async () => {
      await Bun.sleep(0)
    })

    calls.length = 0
    const restore = [...host.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('取消归档'))
    expect(restore).toBeDefined()
    await act(async () => {
      restore?.click()
    })
    await act(async () => {
      await Bun.sleep(0)
    })

    const call = calls.find((c) => c.method === 'threads.setArchived')
    expect(call?.params).toEqual({ threadId: ARCHIVED_THREAD.id, archived: false })
    /* 取消归档不是删除：不能顺手把那一行真的删掉。 */
    expect(calls.some((c) => c.method === 'threads.delete')).toBe(false)
  })
  /* 点「永久删除」→ 确认框里再点「永久删除」 */
  async function confirmDeleteOf(host: HTMLElement, title: string): Promise<void> {
    const trigger = host.querySelector(`button[aria-label="永久删除 ${title}"]`) as HTMLButtonElement | null
    expect(trigger).not.toBeNull()
    await act(async () => {
      trigger?.click()
    })
    const confirm = [...document.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').trim() === '永久删除' && b.getAttribute('aria-label') === null,
    )
    expect(confirm).toBeDefined()
    await act(async () => {
      confirm?.click()
    })
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await Bun.sleep(0)
      })
    }
  }

  async function openArchived(): Promise<HTMLElement> {
    const { host, nav } = await mountSettings()
    await act(async () => {
      nav.navigate({ surface: 'workbench.settings', params: { page: 'conversation.archived' } })
    })
    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        await Bun.sleep(0)
      })
    }
    return host
  }

  /* 那一行已经不在了（别处删掉、上一次其实删完了）：与删除成功同一结局，不再报「删除失败」 */
  test('永久删除遇到 thread_not_found：按已删除处理，确认框关掉', async () => {
    failures = { 'threads.delete': { code: 'conversation.thread_not_found', message: '对话不存在' } }
    const host = await openArchived()
    await confirmDeleteOf(host, ARCHIVED_THREAD.title)

    expect(calls.some((c) => c.method === 'threads.delete')).toBe(true)
    expect(document.body.textContent ?? '').not.toContain('删除失败')
    expect(document.body.textContent ?? '').not.toContain('此操作无法撤销')
  })

  /* 真实故障排查时两头都空：屏幕上只有「请重试」、日志里什么都没有。现在把 Core 给的原因带上屏幕 */
  test('永久删除失败：确认框里显示 Core 给的原因，而不是一句「请重试」', async () => {
    failures = { 'threads.delete': { code: 'conversation.thread_busy', message: '对话正在运行，请先停止' } }
    const host = await openArchived()
    await confirmDeleteOf(host, ARCHIVED_THREAD.title)

    expect(document.body.textContent ?? '').toContain('删除失败：对话正在运行，请先停止')
  })
})
