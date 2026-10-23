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
 * R-24：设置页「已配置的模型」里关掉的模型不进输入框的模型菜单，且**拨一下当场生效**，不靠重启、不靠重开对话。
 * 原先 conversation 根本不读 `modelPicker.hiddenModels`：开关只写进了偏好，菜单照旧列全量。
 * 这里装真实的 preferences + conversation，偏好变更走 Core 推来的 `prefs.changed`（设置页 update 之后宿主发的那一条）。
 */

const WORKSPACE = {
  id: 'w-1',
  name: 'poietica',
  path: 'D:/x/poietica',
  kind: 'folder',
  createdAt: 1_791_300_000_000,
}
const ref = (id: string) => ({ provider: 'deepseek', id })
const CONTROLS = {
  model: {
    current: ref('flash'),
    choices: [
      { ref: ref('flash'), label: 'DeepSeek V4.1 Flash', reasoning: true, images: false },
      { ref: ref('v4-pro'), label: 'DeepSeek V4 Pro', reasoning: true, images: false },
      { ref: ref('v4-flash'), label: 'DeepSeek V4 Flash', reasoning: true, images: false },
    ],
  },
  thinking: { current: 'high', choices: [{ id: 'high', label: 'High' }] },
  posture: 'ask',
  planMode: false,
  goal: null,
  available: { plan: true, goal: true },
  context: null,
}
const prefsWith = (hiddenModels: string[]) => ({
  theme: 'system',
  language: 'zh-CN',
  logLevel: 'info',
  general: { sendWithModifier: false, confirmBeforeDelete: true, notifyOnCompletion: true },
  appearance: { density: 'comfortable', reduceMotion: false, messageTimestamps: false },
  modelPicker: { hiddenModels, providerOrder: [] },
  updates: { autoCheck: true },
})

const THREAD = {
  id: 't-1',
  workspaceId: 'w-1',
  title: '你好',
  titleSource: 'auto',
  posture: 'ask',
  origin: 'user',
  state: 'idle',
  pendingInteraction: null,
  hasSession: true,
  forkedFrom: null,
  pinned: false,
  archived: false,
  createdAt: 1_791_300_000_000,
  updatedAt: 1_791_300_000_000,
}

let push: (method: string, params: unknown) => void = () => undefined

function testBridge(): WindowBridge {
  const listeners = new Set<(m: RpcMessage) => void>()
  const replies: Readonly<Record<string, unknown>> = {
    'core.getStatus': { state: 'ready', reason: null, attempt: 0 },
    'threads.list': { threads: [THREAD] },
    'workspaces.list': { workspaces: [WORKSPACE] },
    'keymap.get': { overrides: {} },
    'uiState.get': { value: null },
    'prefs.get': prefsWith(['deepseek/v4-pro']),
    'controls.draft': CONTROLS,
    'controls.get': CONTROLS,
  }
  push = (method, params) => {
    for (const l of [...listeners]) l({ jsonrpc: '2.0', method, params } as RpcMessage)
  }
  return {
    send(message: RpcMessage) {
      if ('id' in message && typeof message.id === 'number' && 'method' in message) {
        const id = message.id
        const result = replies[message.method as string] ?? {}
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

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Bun.sleep(0)
    })
  }
}

/* 打开「模型与思考档位」那张面板，再点档位页的头一行换到模型清单页（与人手同一条路） */
async function openMenu(host: HTMLElement) {
  const button = host.querySelector<HTMLElement>('.assistant-model-select__button')
  expect(button).not.toBeNull()
  await act(async () => {
    button?.click()
  })
  await settle()
  const head = document.querySelector<HTMLElement>('.assistant-model-select__head')
  expect(head).not.toBeNull()
  await act(async () => {
    head?.click()
  })
  await settle()
}

const listed = () =>
  [...document.querySelectorAll('.assistant-model-select__item-name')].map((node) => node.textContent ?? '')

const roots: Root[] = []

async function scenario(route: { readonly surface: string; readonly params: Readonly<Record<string, string>> }) {
  const host = document.createElement('div')
  document.body.append(host)
  const kernel = createUiKernel({
    features: [workbenchFeature, platform, preferences, workspaces, attachments, conversation],
    errorMessages: {},
    validateResults: false,
    defaultRoute: route,
    bridge: testBridge(),
  })
  await kernel.start()
  const root = createRoot(host)
  roots.push(root)
  await act(async () => {
    root.render(
      <KernelProvider kernel={kernel}>
        <Workbench />
      </KernelProvider>,
    )
  })
  await settle()

  await openMenu(host)
  expect(listed()).toEqual(['DeepSeek V4.1 Flash', 'DeepSeek V4 Flash'])

  /* 再关一条、并把 Pro 打开：菜单开着也要当场换，不等关掉重开 */
  await act(async () => {
    push('prefs.changed', prefsWith(['deepseek/v4-flash']))
  })
  await settle()
  expect(listed()).toEqual(['DeepSeek V4.1 Flash', 'DeepSeek V4 Pro'])

  /* 关掉的是当前在用的那一条：它仍是这段对话的模型，菜单里留着它（按钮上的名字要找得到） */
  await act(async () => {
    push('prefs.changed', prefsWith(['deepseek/flash', 'deepseek/v4-flash', 'deepseek/v4-pro']))
  })
  await settle()
  expect(listed()).toEqual(['DeepSeek V4.1 Flash'])

  await act(async () => {
    push('prefs.changed', prefsWith([]))
  })
  await settle()
  expect(listed()).toEqual(['DeepSeek V4.1 Flash', 'DeepSeek V4 Pro', 'DeepSeek V4 Flash'])
}

describe('输入框的模型菜单跟着设置页的显示开关走', () => {
  afterEach(async () => {
    await act(async () => {
      for (const root of roots.splice(0)) root.unmount()
    })
    document.body.innerHTML = ''
  })

  test('新对话入口：关掉的不列，开关一拨当场变，当前在用的那一条始终在', async () => {
    await scenario({ surface: 'conversation.home', params: {} })
  })

  test('已有对话：同一条规则，同样当场生效', async () => {
    await scenario({ surface: 'conversation.thread', params: { threadId: 't-1' } })
  })
})
