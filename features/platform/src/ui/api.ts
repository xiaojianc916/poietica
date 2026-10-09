import type { UiFeatureContext } from '@poietica/ui-kernel'
import { type AppInfo, type CoreDiagnostics, platformContract, type StorageEntry, type UiLogEntry } from '../contract'

/** 对 ctx.rpc(platformContract) 的薄封装：测试时整体替换为假对象 */
export function createPlatformApi(ctx: UiFeatureContext) {
  const rpc = ctx.rpc(platformContract)
  return {
    appInfo: (): Promise<AppInfo> => rpc.call('app.info', {}),
    quit: (): Promise<void> => rpc.call('app.quit', {}).then(() => undefined),
    minimize: (): Promise<void> => rpc.call('window.minimize', {}).then(() => undefined),
    toggleMaximize: (): Promise<void> => rpc.call('window.toggleMaximize', {}).then(() => undefined),
    close: (): Promise<void> => rpc.call('window.close', {}).then(() => undefined),
    openDevtools: (): Promise<void> => rpc.call('window.openDevtools', {}).then(() => undefined),
    isMaximized: (): Promise<{ maximized: boolean }> => rpc.call('window.isMaximized', {}),
    openExternal: (url: string): Promise<void> => rpc.call('shell.openExternal', { url }).then(() => undefined),
    openPath: (path: string): Promise<void> => rpc.call('shell.openPath', { path }).then(() => undefined),
    trashItem: (path: string): Promise<void> => rpc.call('shell.trashItem', { path }).then(() => undefined),
    showNotification: (o: { title: string; body: string; threadId?: string }): Promise<void> =>
      rpc.call('notify.show', o).then(() => undefined),
    logWrite: (entries: readonly UiLogEntry[]): Promise<void> =>
      rpc.call('log.write', { entries: [...entries] }).then(() => undefined),
    storageUsage: (): Promise<{ entries: StorageEntry[] }> => rpc.call('storage.usage', {}),
    storageClear: (target: 'cache' | 'logs' | 'browser'): Promise<{ freedBytes: number }> =>
      rpc.call('storage.clear', { target }),
    openDataFolder: (): Promise<void> => rpc.call('storage.openDataFolder', {}).then(() => undefined),
    diagnostics: (): Promise<CoreDiagnostics> => rpc.call('diagnostics.core', {}),
    onMaximizedChanged: (listener: (maximized: boolean) => void) =>
      rpc.on('window.maximizedChanged', (p) => listener(p.maximized)),
    onCloseRequested: (listener: () => void) => rpc.on('window.closeRequested', () => listener()),
    onNotifyClicked: (listener: (threadId: string | null) => void) =>
      rpc.on('notify.clicked', (p) => listener(p.threadId)),
  }
}

export type PlatformApi = ReturnType<typeof createPlatformApi>
