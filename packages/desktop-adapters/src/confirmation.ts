import type { ConfirmationPort } from '@poietica/settings'
import { ask } from '@tauri-apps/plugin-dialog'

/**
 * 使用 Tauri dialog 插件显示异步确认框。
 *
 * 不调用 window.confirm：Tauri WebView 会拦截该浏览器 API，部分运行时组合会把它
 * 路由到不存在的 dialog.confirm 命令。显式调用 ask 会走已注册的插件命令，
 * 同时保留自定义按钮文案。
 */
export const confirmWithNativeDialog: ConfirmationPort = ({
  cancelLabel,
  message,
  okLabel,
  title,
}) =>
  ask(message, {
    cancelLabel,
    kind: 'warning',
    okLabel,
    title,
  })
