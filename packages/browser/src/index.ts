/* 包的公开面。显式罗列而不是 export *：谁在用什么必须一眼可见。 */
export { BrowserPanel, type DockPaneRenderers } from './browser-panel'
/* 同 automations：进程级 store 常量的类型必须可命名。 */
export { type BrowserPanelStore, createBrowserPanelStore } from './browser-panel-store'
