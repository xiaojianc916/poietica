import type { BrowserHostPort } from '@poietica/browser'
import {
  browserTabBack,
  browserTabForward,
  browserTabReload,
  closeBrowserTab,
  navigateBrowserTab,
  openBrowserTab,
  openBrowserUrlExternally,
  printBrowserTab,
  reopenClosedBrowserTab,
  selectBrowserTab,
  setBrowserElementPicker,
  setBrowserViewportBounds,
  setBrowserVisible,
  watchBrowserState,
} from '@poietica/native-bridge'

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
