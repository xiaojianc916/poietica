import type { Session } from 'electron'
import { BROWSER_PARTITION } from '../contract/entities'

/*
 * 07 页 §12D 的完整代码：内置浏览器分区拒绝所有敏感权限；下载走系统「另存为」对话框。
 *
 * 与主窗口的 defaultSession 策略分开：外站页面能拿到的东西比应用界面少得多。
 */

const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])

export function applySessionPolicy(s: Session): void {
  s.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)))
  s.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
  s.setDevicePermissionHandler(() => false)
  s.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: '保存文件' })
  })
}

/** 面板标签所在的会话分区名；relay 报告浏览器身份（UA）时也要用它。 */
export { BROWSER_PARTITION }
