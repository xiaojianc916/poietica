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
 * 侧栏线程列表的选择器**必须交回稳定引用**（真机实测故障）。
 *
 * 原实现把「row 形状」直接写进 useFeatureStoreShallow 的选择器里：`s.items.map(thread => ({...}))`
 * 每次调用都造一个新的行数组、每个元素也是新对象。useShallow 比的是**数组元素**
 * （zustand 的 shallow：数组走 compareIterables，逐项 Object.is），于是每帧都判「变了」——
 * 一条线程都没有时它返回空数组、总判相等，看不出来；**发出第一句话、列表长出第一行之后**，
 * React 立刻进入 "Maximum update depth exceeded"，整个 conversation 的侧栏那一段被错误边界
 * 接管（截图里就是「“conversation” 出现错误」）。
 *
 * 这一条测试就是那个相位：先渲染（此时列表为空），再让 threads.list 回一条线程并重渲染。
 * 修好之前它在第二阶段抛错（错误边界会渲染 [data-feature-error]）；修好之后 DOM 里既没有
 * 错误边界，也真的有那一行。
 *
 * 装配 conversation 与它声明的那三个依赖（workspaces / preferences / platform），而不是
 * 复刻一份 —— 要钉的正是 ui/index.tsx 里那一段选择器，而它住在 conversation 功能的装配层。
 * 不把全部功能拉进来：其余功能的 onCoreReady 各有自己的第一次读盘，测的就不是这一条了。
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

/** 这一次启动里所有发出去的 RPC 方法名（按顺序）。断言「点加号没有建线程」用它。 */
const calls: string[] = []

/**
 * 按方法回话的假 bridge。
 *
 * `threads.list` 回一条线程 —— 这是触发那一次重渲染的唯一一件事。
 *
 * 其余几格要照**契约的形状**给：`core.getStatus` 一旦是 ready，各功能的 onCoreReady
 * 就会真的去读自己的那一份（preferences 读 prefs.get / uiState.get / keymap.get，
 * workspaces 读 workspaces.list）。给 `{}` 会让它们当场抛错（workspaces 的 items 是
 * undefined，conversation 的 HomeSurface 一渲染就炸），测出来的就不是我们要钉的那一条了。
 */
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
        if ('method' in message) calls.push(message.method as string)
        const result = replies[message.method] ?? {}
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

describe('侧栏线程列表的选择器', () => {
  let root: Root | null = null

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
  })

  test('列表长出第一行之后不炸（选择器交回稳定引用）', async () => {
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

    /*
     * 第一段：首帧（列表还空着）。第二段：等 core.getStatus=ready 触发的
     * threads.refresh 回来 —— 这一条让列表长出第一行，正是故障的相位。
     */
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

    expect(host.querySelector('[data-feature-error="conversation"]')).toBeNull()
    expect(host.textContent ?? '').toContain('你好')
  })

  /*
   * 工作区组头右侧的加号 = **打开入口页**，不是当场建一条空线程。
   *
   * legacy 的同一格（`assistant-sidebar-panel.tsx` 的 `create`）先 setActiveWorkspaceRoot
   * 再打开 'ai' 表面；号由入口页发出第一句话时的 prepare() 铸。原先这里直接
   * createThread + openThread，点两下库里就多两条 title_source='pending' 的空行。
   *
   * 判据两条：① 点完之后路由停在入口页（页面上有那只输入框）；② 全程**没有**
   * `threads.create` 发出去 —— 这是这条缺陷唯一能钉死的地方，光看界面看不出来。
   */
  test('工作区组头的加号打开入口页，不预建空线程', async () => {
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

    /* 组头那一枚的 aria-label 是「在<工作区名>中新建对话」（与 legacy 同字）。 */
    const plus = host.querySelector<HTMLButtonElement>('button[aria-label="在poietica中新建对话"]')
    expect(plus).not.toBeNull()

    /* 先切去线程页，这样「回到入口页」才是这个动作真的做出来的效果。 */
    const nav = kernel.kernelServices.navigation
    await act(async () => {
      nav.navigate({ surface: 'conversation.thread', params: { threadId: THREAD.id } })
    })
    await act(async () => {
      await Bun.sleep(0)
    })
    expect(nav.current().route.surface).toBe('conversation.thread')

    calls.length = 0
    await act(async () => {
      plus?.click()
    })
    await act(async () => {
      await Bun.sleep(0)
    })

    expect(calls).not.toContain('threads.create')
    expect(nav.current().route.surface).toBe('conversation.home')
  })
})
