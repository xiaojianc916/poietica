import type { BrowserHostPort, BrowserViewportBounds } from '@poietica/auxiliary/browser'
import { commands, events } from '@poietica/contract'
import { throughIpc } from '../error'

export type { BrowserViewportBounds } from '@poietica/auxiliary/browser'
export type {
  BrowserClosedTab,
  BrowserElementPicked,
  BrowserPickSubmission,
  BrowserState,
  BrowserTab,
} from '@poietica/contract'

import type { BrowserElementPicked, BrowserState } from '@poietica/contract'

export async function watchBrowserState(
  onState: (state: BrowserState) => void,
): Promise<() => void> {
  let latestRevision = -1

  const accept = (state: BrowserState): void => {
    if (state.revision <= latestRevision) {
      return
    }

    latestRevision = state.revision
    onState(state)
  }

  const unlisten = await events.browserState.listen((event) => {
    accept(event.payload)
  })

  accept(await throughIpc(() => commands.browserState()))
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

export async function printBrowserTab(id: number): Promise<void> {
  await throughIpc(() => commands.browserPrint(id))
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

export function openBrowserUrlExternally(url: string): Promise<void> {
  return throughIpc(() => commands.windowOpenExternalUrl(url))
}

export function browserDevtoolsEndpoint(): Promise<string | null> {
  return throughIpc(() => commands.browserDevtoolsEndpoint())
}

export function setBrowserElementPicker(id: number, enabled: boolean): Promise<void> {
  return throughIpc(() => commands.browserSetElementPicker(id, enabled))
}

export function watchBrowserElementPicked(
  onPicked: (picked: BrowserElementPicked) => void,
): Promise<() => void> {
  return events.browserElementPicked.listen((event) => {
    onPicked(event.payload)
  })
}

/* 端口的每一格就是一条 IPC 命令：请求与动作两边同一份生成类型。 */
export const browserHostPort: BrowserHostPort = {
  watch: watchBrowserState,
  openTab: openBrowserTab,
  closeTab: closeBrowserTab,
  selectTab: selectBrowserTab,
  navigate: navigateBrowserTab,
  back: browserTabBack,
  forward: browserTabForward,
  reload: browserTabReload,
  print: printBrowserTab,
  setElementPicker: setBrowserElementPicker,
  reopenClosed: reopenClosedBrowserTab,
  setViewportBounds: setBrowserViewportBounds,
  setVisible: setBrowserVisible,
  openExternally: openBrowserUrlExternally,
}
