import { mkdirSync } from 'node:fs'
import { type DataLayout, dataLayout, resolveDataRoot } from '@poietica/runtime-layout'
import { app } from 'electron'

export interface AppIdentity {
  readonly isPackaged: boolean
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
  app.setAppLogsPath(layout.logsDir)
  // 08 页 §1 的“谁创建目录”表：root 与 logsDir 由这里在启动第一步创建（日志之前）。
  // 其余目录各归其主（CoreSupervisor 的 mustExistDirs / 各 Core 模块的第一次写入）。
  mkdirSync(layout.root, { recursive: true })
  mkdirSync(layout.logsDir, { recursive: true })
  app.setAppUserModelId(isPackaged ? 'com.poietica.Poietica' : 'com.poietica.Poietica.Dev') // 与 electron-builder appId 一致（沿用 legacy，保证覆盖升级）
  return { isPackaged, layout }
}
