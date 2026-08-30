import { commands, events } from '@poietica/contract'
import { throughIpc } from './error'

export type {
  BrowserClosedTab,
  BrowserElementPicked,
  BrowserPickSubmission,
  BrowserState,
  BrowserTab,
} from '@poietica/contract'

import type { BrowserElementPicked, BrowserState } from '@poietica/contract'

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
