import type { BrowserHostPort, BrowserPopupRequest } from '@poietica/browser'
import {
  browserTabBack,
  browserTabForward,
  browserTabReload,
  closeBrowserPopup,
  closeBrowserTab,
  type BrowserPopupRequest as NativeBrowserPopupRequest,
  navigateBrowserTab,
  openBrowserPopup,
  openBrowserTab,
  printBrowserTab,
  reopenClosedBrowserTab,
  selectBrowserTab,
  sendBrowserPopupAction,
  setBrowserElementPicker,
  setBrowserViewportBounds,
  setBrowserVisible,
  watchBrowserPopupActions,
  watchBrowserState,
} from '@poietica/ipc'

function toNativeRequest(request: BrowserPopupRequest): NativeBrowserPopupRequest {
  return {
    kind: request.kind,
    theme: request.theme,
    panes: request.panes.map((pane) => ({ id: pane.id, title: pane.title })),
    activePaneId: request.activePaneId,
  }
}

export const browserHostPort: BrowserHostPort = {
  watch: watchBrowserState,
  watchPopupActions: (onAction) =>
    watchBrowserPopupActions((action) => {
      onAction({
        action: action.action,
        paneId: action.paneId,
        tabId: action.tabId,
        index: action.index,
      })
    }),
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
  openPopup: (request, rect) =>
    openBrowserPopup(toNativeRequest(request), rect.x, rect.y, rect.width, rect.height),
  dispatchPopupAction: (action) =>
    sendBrowserPopupAction({
      action: action.action,
      paneId: action.paneId,
      tabId: action.tabId,
      index: action.index,
    }),
  closePopup: closeBrowserPopup,
}
