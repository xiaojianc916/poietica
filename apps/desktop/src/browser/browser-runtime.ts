import { createBrowserPanelStore } from '@poietica/browser'
import {
  browserTabBack,
  browserTabForward,
  browserTabReload,
  closeBrowserTab,
  navigateBrowserTab,
  openBrowserDevtools,
  openBrowserTab,
  openBrowserUrlExternally,
  reopenClosedBrowserTab,
  selectBrowserTab,
  setBrowserElementPicker,
  setBrowserViewportBounds,
  setBrowserVisible,
  watchBrowserState,
} from '@poietica/ipc'

/*
 * 端口在应用层接上：@poietica/browser 声明形状，生成绑定实现它 ——
 * 与 plugin-runtime 给 pluginStore 接 palette 桥是同一条纪律。
 * 状态店一个进程一份，模块级建一次（与 pluginStore 同款）。
 */
export const browserPanelStore = createBrowserPanelStore({
  watch: watchBrowserState,
  openTab: openBrowserTab,
  closeTab: closeBrowserTab,
  selectTab: selectBrowserTab,
  navigate: navigateBrowserTab,
  back: browserTabBack,
  forward: browserTabForward,
  reload: browserTabReload,
  setElementPicker: setBrowserElementPicker,
  reopenClosed: reopenClosedBrowserTab,
  setViewportBounds: setBrowserViewportBounds,
  setVisible: setBrowserVisible,
  openDevtools: openBrowserDevtools,
  openExternal: openBrowserUrlExternally,
})
