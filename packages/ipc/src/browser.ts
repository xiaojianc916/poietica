import { throughIpc } from './error'
import { commands, events } from './generated/ipc-bindings'

/*
 * 内置浏览器的 IPC 面。
 *
 * DTO 一个字都不在这里声明：原生侧的 browser.rs 是权威，形状经由生成绑定过来。
 * 状态是原生侧广播的全量快照 —— 挂监听与「现在就看一眼」合成一个函数，顺序
 * 固定为先挂后拉，与 automations.ts 的 watch 同一条规矩。
 */

export type {
  BrowserClosedTab,
  BrowserElementPicked,
  BrowserPickSubmission,
  BrowserState,
  BrowserTab,
} from './generated/ipc-bindings'

import type { BrowserElementPicked, BrowserState } from './generated/ipc-bindings'

export interface BrowserViewportBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export async function watchBrowserState(
  onState: (state: BrowserState) => void,
): Promise<() => void> {
  const unlisten = await events.browserState.listen((event) => {
    onState(event.payload)
  })

  onState(await throughIpc(() => commands.browserState()))

  return unlisten
}

export function openBrowserTab(url: string | null): Promise<void> {
  return throughIpc(() => commands.browserOpenTab(url))
}

export function closeBrowserTab(id: number): Promise<void> {
  return throughIpc(() => commands.browserCloseTab(id))
}

export function selectBrowserTab(id: number): Promise<void> {
  return throughIpc(() => commands.browserSelectTab(id))
}

export function navigateBrowserTab(id: number, address: string): Promise<void> {
  return throughIpc(() => commands.browserNavigate(id, address))
}

export function browserTabBack(id: number): Promise<void> {
  return throughIpc(() => commands.browserBack(id))
}

export function browserTabForward(id: number): Promise<void> {
  return throughIpc(() => commands.browserForward(id))
}

export function browserTabReload(id: number): Promise<void> {
  return throughIpc(() => commands.browserReload(id))
}

export function reopenClosedBrowserTab(index: number): Promise<void> {
  return throughIpc(() => commands.browserReopenClosed(index))
}

export function setBrowserViewportBounds(bounds: BrowserViewportBounds): Promise<void> {
  return throughIpc(() =>
    commands.browserSetBounds(bounds.x, bounds.y, bounds.width, bounds.height),
  )
}

export function setBrowserVisible(visible: boolean): Promise<void> {
  return throughIpc(() => commands.browserSetVisible(visible))
}

export function openBrowserDevtools(id: number): Promise<void> {
  return throughIpc(() => commands.browserOpenDevtools(id))
}

/** 图三「在默认浏览器中打开」：复用既有的 window 命令，协议白名单在原生侧。 */
export function openBrowserUrlExternally(url: string): Promise<void> {
  return throughIpc(() => commands.windowOpenExternalUrl(url))
}

/** 内核 CDP 端点；非 Windows 或端口没抽到时为 null，mcp.json 对账用。 */
export function browserDevtoolsEndpoint(): Promise<string | null> {
  return throughIpc(() => commands.browserDevtoolsEndpoint())
}

/** 显式开启或关闭元素选择；真实状态由 BrowserState.pickingTabId 返回。 */
export function setBrowserElementPicker(id: number, enabled: boolean): Promise<void> {
  return throughIpc(() => commands.browserSetElementPicker(id, enabled))
}

/** 拾取结果流。只挂监听 —— 没有「当前值」可拉，事件只在点下那一刻存在。 */
export function watchBrowserElementPicked(
  onPicked: (picked: BrowserElementPicked) => void,
): Promise<() => void> {
  return events.browserElementPicked.listen((event) => {
    onPicked(event.payload)
  })
}
