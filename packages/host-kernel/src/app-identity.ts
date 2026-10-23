import { mkdirSync } from 'node:fs'
import { CHROMIUM_HTTP_CACHE_BYTES, type DataLayout, dataLayout, resolveDataRoot } from '@poietica/runtime-layout'
import { app } from 'electron'

/*
 * Windows 的 AppUserModelID。
 *
 * 任务栏按键按它归档，**图标也按它取**：按键画的是该身份对应快捷方式的那张图，窗口自己的
 * WM_SETICON 图标在这里不作数。开发版另立一个身份（与数据根分家同一个理由），否则开发版
 * 与安装版共用 com.poietica.Poietica 时，谁先跑谁把图标写进系统缓存。
 *
 * 安装版这个字符串必须与 electron-builder.yml 的 appId 一致：打包器按它写进快捷方式。
 */
export const PACKAGED_APP_ID = 'com.poietica.Poietica'
export const DEV_APP_ID = 'com.poietica.Poietica.Dev'

export interface AppIdentity {
  readonly isPackaged: boolean
  /** Windows 的 AppUserModelID：任务栏按键归档、图标查找、通知归属都认它 */
  readonly appId: string
  readonly layout: DataLayout
}

/** 必须在 app ready 之前调用：setPath('userData'/'sessionData') 在 ready 之后调用无效 */
export function configureAppIdentity(): AppIdentity {
  const isPackaged = app.isPackaged
  app.setName(isPackaged ? 'Poietica' : 'Poietica Dev')
  const layout = dataLayout(
    resolveDataRoot({
      isPackaged,
      appDataDir: app.getPath('appData'),
      override: app.commandLine.getSwitchValue('poietica-data-root') || null,
    }),
  )
  app.setPath('userData', layout.root)
  app.setPath('sessionData', layout.chromiumSessionDir)
  // 会话数据的位置与 HTTP 缓存的上限一起定：不给上限，Chromium 按磁盘剩余空间给每个会话最多 320 MB（storage-budget.ts）
  app.commandLine.appendSwitch('disk-cache-size', String(CHROMIUM_HTTP_CACHE_BYTES))
  app.setAppLogsPath(layout.logsDir)
  // root 与 logsDir 由这里在启动第一步创建（日志之前）；其余目录各归其主
  // （CoreSupervisor 的 mustExistDirs / 各 Core 模块的第一次写入）。
  mkdirSync(layout.root, { recursive: true })
  mkdirSync(layout.logsDir, { recursive: true })
  const appId = isPackaged ? PACKAGED_APP_ID : DEV_APP_ID
  app.setAppUserModelId(appId)
  return { isPackaged, appId, layout }
}
