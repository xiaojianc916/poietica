import type { Session } from 'electron'
import { BROWSER_PARTITION } from '../contract/entities'

/* 内置浏览器分区拒绝所有敏感权限，下载走系统「另存为」对话框；与主窗口的 defaultSession 分开 —— 外站页面能拿到的东西少得多。 */

const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])

export function applySessionPolicy(s: Session): void {
  s.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)))
  s.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
  s.setDevicePermissionHandler(() => false)
  s.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: '保存文件' })
  })
}

export { BROWSER_PARTITION }
