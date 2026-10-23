import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 应用图标的文件名。`.ico` 里装着 16/24/32/48/64/256 各一档，Windows 按自己的 DPI 挑那一档，
 * 一位像素都不用重采样 —— 只发 PNG 的话，150% 缩放的屏上 512 的图被硬缩到托盘那一档再被系统放大回来。
 */
export const APP_ICON_FILE = 'icon.ico'

/**
 * 图标所在目录里的两处候选：打包产物是 `<resources>/`，开发期是 `apps/desktop/resources/`。
 * 后者由 `apps/desktop/src/main/index.ts` 算好，经 `paths.resourcesDir` 传进内核 —— 没有这条线，
 * 开发版就只能退回 electron.exe 自带的原子图。
 */
export function resolveAppIcon(resourcesDir: string): string | undefined {
  const candidate = path.join(resourcesDir, APP_ICON_FILE)
  return existsSync(candidate) ? candidate : undefined
}
