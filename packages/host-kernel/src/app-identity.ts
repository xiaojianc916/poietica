import { mkdirSync } from 'node:fs'
import { CHROMIUM_HTTP_CACHE_BYTES, type DataLayout, dataLayout, resolveDataRoot } from '@poietica/runtime-layout'
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
  // 会话数据的位置与 HTTP 缓存的上限一起定：不给上限，Chromium 按磁盘剩余空间给每个会话最多 320 MB（storage-budget.ts）
  app.commandLine.appendSwitch('disk-cache-size', String(CHROMIUM_HTTP_CACHE_BYTES))
  app.setAppLogsPath(layout.logsDir)
  // root 与 logsDir 由这里在启动第一步创建（日志之前）；其余目录各归其主
  // （CoreSupervisor 的 mustExistDirs / 各 Core 模块的第一次写入）。
  mkdirSync(layout.root, { recursive: true })
  mkdirSync(layout.logsDir, { recursive: true })
  app.setAppUserModelId(isPackaged ? 'com.poietica.Poietica' : 'com.poietica.Poietica.Dev') // 与 electron-builder 的 appId 一致，保证覆盖升级
  return { isPackaged, layout }
}
