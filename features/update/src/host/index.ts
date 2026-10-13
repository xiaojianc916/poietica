import { systemClock } from '@poietica/foundation'
import { defineHostModule } from '@poietica/host-kernel'
import { autoUpdater } from 'electron-updater'
import { updateContract } from '../contract'
import { createUpdateService, type UpdaterPort } from './update-service'

/**
 * update 的 Host 装配。**本文件是唯一 import electron-updater 的地方**：状态机只认识 `UpdaterPort`，所以全部相位转换都能用假端口单测。
 * 开发版（ctx.isPackaged 为 false）也走同一台更新器：`forceDevUpdateConfig` 打开之后它改读 apps/desktop/dev-app-update.yml，阶段与安装版
 * 完全相同。安装为什么能成功：`ctx.app.quit({finalize})` 先走完整退出流程，最后调 `autoUpdater.quitAndInstall(true, true)`；它内部调
 * `app.quit()`，此时 quitting 已为真，before-quit 不再拦截，Electron 正常发出 quit 事件，electron-updater 在该事件中启动 NSIS 安装程序。
 */
export default defineHostModule({
  id: 'update',
  contract: updateContract,
  setup(ctx) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger = null
    /* 未打包时 electron-updater 默认直接跳过检查；这一项让它改读 app 根目录下的 `dev-app-update.yml`。缓存目录另起一名，开发版的待装
     * 字节不与安装版混在一起。 */
    autoUpdater.forceDevUpdateConfig = !ctx.isPackaged
    const updater: UpdaterPort = {
      checkForUpdates: () => autoUpdater.checkForUpdates(),
      downloadUpdate: () => autoUpdater.downloadUpdate(),
      quitAndInstall: () => {
        autoUpdater.quitAndInstall(true, true)
      },
      onDownloadProgress: (handler) => {
        const listener = (p: { percent: number }): void => {
          handler(p.percent)
        }
        autoUpdater.on('download-progress', listener)
        return () => {
          autoUpdater.off('download-progress', listener)
        }
      },
    }
    const service = createUpdateService({
      updater,
      currentVersion: ctx.appVersion,
      logger: ctx.logger,
      clock: systemClock,
      quit: (finalize) => ctx.app.quit({ finalize }),
    })
    ctx.disposables.add(service.onChange((s) => ctx.rpc.emit('update.stateChanged', s)))
    ctx.rpc.handle('update.state', () => service.state())
    ctx.rpc.handle('update.check', () => service.check())
    ctx.rpc.handle('update.download', () => service.download())
    ctx.rpc.handle('update.install', () => service.install())
  },
})
