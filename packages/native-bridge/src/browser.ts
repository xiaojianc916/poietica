import type { BrowserHostPort, BrowserViewportBounds } from '@poietica/browser'
import type { BrowserElementPicked, BrowserState, ResolvedTheme } from '@poietica/contract/browser'
import { hostBridge } from './host-bridge'
import { throughIpc } from './ipc-error'

export type { BrowserViewportBounds } from '@poietica/browser'
export type {
  BrowserClosedTab,
  BrowserElementPicked,
  BrowserPickSubmission,
  BrowserState,
  BrowserTab,
  ResolvedTheme,
} from '@poietica/contract/browser'

/*
 * 内置浏览器：命令经 window.poietica.invoke 直达主进程自建的命令表（browser_state、
 * browser_open_tab…），与原生命令走同一条通道 —— preload 不多开一层 host.browser，
 * 多一层就是第二个事实。标签模型的类型归 @poietica/contract/browser（手写正本），
 * 原生侧不再有 browser_* 命令，所以这里没有生成的 DTO 可用。
 */
function invoke<T>(command: string, args: unknown): Promise<T> {
  return throughIpc(async () => (await window.poietica.invoke(command, args)) as T)
}

/*
 * agent 正要动内置浏览器。面板据此自己开出来 —— 用户不必先去点一下那一格，
 * 而 AI 动的时候页面就在眼前。
 *
 * 判据是宿主侧的 relay 连上了（main.ts 的 browserRelay.onDriven）：relay 服务端由 omp
 * 自己的浏览器前奏按需拉起，所以这个信号说的是「agent 现在要用」而不是「应用起来了」。
 */
export function watchBrowserDriven(onDriven: () => void): () => void {
  return window.poietica.on('browser-driven', () => {
    onDriven()
  })
}

export function watchBrowserState(onState: (state: BrowserState) => void): Promise<() => void> {
  let latestRevision = -1

  const accept = (state: BrowserState): void => {
    if (state.revision <= latestRevision) {
      return
    }

    latestRevision = state.revision
    onState(state)
  }

  const stop = window.poietica.on('browser-state', (payload) => {
    accept(payload as BrowserState)
  })

  return invoke<BrowserState>('browser_state', null).then(
    (state) => {
      accept(state)
      return stop
    },
    (cause: unknown) => {
      stop()
      throw cause
    },
  )
}

export function openBrowserTab(url: string | null): Promise<void> {
  return invoke('browser_open_tab', { url })
}

export function closeBrowserTab(id: number): Promise<void> {
  return invoke('browser_close_tab', { id })
}

export function selectBrowserTab(id: number): Promise<void> {
  return invoke('browser_select_tab', { id })
}

export function navigateBrowserTab(id: number, address: string): Promise<void> {
  return invoke('browser_navigate', { id, address })
}

export function browserTabBack(id: number): Promise<void> {
  return invoke('browser_back', { id })
}

export function browserTabForward(id: number): Promise<void> {
  return invoke('browser_forward', { id })
}

export function browserTabReload(id: number): Promise<void> {
  return invoke('browser_reload', { id })
}

export function printBrowserTab(id: number): Promise<void> {
  return invoke('browser_print', { id })
}

export function reopenClosedBrowserTab(index: number): Promise<void> {
  return invoke('browser_reopen_closed', { index })
}

export function setBrowserViewportBounds(bounds: BrowserViewportBounds): Promise<void> {
  return invoke('browser_set_bounds', {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  })
}

export function setBrowserVisible(visible: boolean): Promise<void> {
  return invoke('browser_set_visible', { visible })
}

/** 标签的缩放；0 是内核默认那一档。 */
export function setBrowserZoom(id: number, level: number): Promise<void> {
  return invoke('browser_set_zoom', { id, level })
}

/** 内核此刻的缩放档。档位的所有者是内核，这里只问它。 */
export function readBrowserZoom(id: number): Promise<number> {
  return invoke('browser_zoom', { id }).then((value) =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0,
  )
}

/* 外链交给系统浏览器；这件事只有宿主做得成，主进程那一侧挂的是 shell.openExternal。
 *
 * 走 preload 装的 host 桥，不走 invoke：这条命令在主进程自己的表里（poietica:open-external），
 * 不在原生命令面上。此前写的是 invoke('window_open_external_url')，而那个名字原生侧没有 ——
 * transport 的 `unknown =>` 分支会把它结算成 NotFound，点击因此必然失败，且失败只落在
 * 控制台里，界面上什么都不会发生。
 */
export function openBrowserUrlExternally(url: string): Promise<void> {
  return hostBridge().host.openExternal(url)
}

export function setBrowserElementPicker(
  id: number,
  enabled: boolean,
  theme: ResolvedTheme,
): Promise<void> {
  return invoke('browser_set_element_picker', { id, enabled, theme })
}

export function watchBrowserElementPicked(
  onPicked: (picked: BrowserElementPicked) => void,
): Promise<() => void> {
  return Promise.resolve(
    window.poietica.on('browser-element-picked', (payload) => {
      onPicked(payload as BrowserElementPicked)
    }),
  )
}

/* 端口的每一格就是一条命令：请求与动作两边同一份类型。 */
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
  setZoom: setBrowserZoom,
  zoom: readBrowserZoom,
  setElementPicker: setBrowserElementPicker,
  reopenClosed: reopenClosedBrowserTab,
  setViewportBounds: setBrowserViewportBounds,
  setVisible: setBrowserVisible,
  openExternally: openBrowserUrlExternally,
}
