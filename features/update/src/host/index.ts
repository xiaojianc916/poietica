import { systemClock } from '@poietica/foundation'
import { defineHostModule } from '@poietica/host-kernel'
import { autoUpdater } from 'electron-updater'
import { updateContract } from '../contract'
import { createUpdateService, type UpdaterPort } from './update-service'

/**
 * update 的 Host 装配（07 页 §15D）。
 *
 * **本文件是唯一 import electron-updater 的地方**：状态机（update-service.ts）只认识
 * `UpdaterPort`，所以全部相位转换都能用假端口单测。开发版（ctx.isPackaged 为 false）
 * 也走同一台更新器（产品负责人 2026-10-08）：`forceDevUpdateConfig` 打开之后，它改读
 * apps/desktop/dev-app-update.yml，阶段与安装版完全相同，更新流程不必先打包才能验收。
 *
 * 安装为什么能成功：`ctx.app.quit({finalize})` 先走完整退出流程（钩子、停 Core、销毁
 * 窗口），最后调用 `autoUpdater.quitAndInstall(true, true)`；它内部调用 `app.quit()`，
 * 此时 quitting 已为真，before-quit 不再拦截，Electron 正常发出 quit 事件，
 * electron-updater 在该事件中启动 NSIS 安装程序（06 页 §4.9 的 QuitOptions.finalize）。
 */
export default defineHostModule({
  id: 'update',
  contract: updateContract,
  setup(ctx) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger = null
    /*
     * 未打包时 electron-updater 默认直接跳过检查；这一项让它改读 app 根目录下的
     * `dev-app-update.yml`（与打包版读 resources/app-update.yml 是同一套字段）。
     * 缓存目录另起一名（见那个文件），开发版的待装字节不与安装版混在一起。
     */
    autoUpdater.forceDevUpdateConfig = !ctx.isPackaged
    const updater: UpdaterPort = {
      checkForUpdates: () => autoUpdater.checkForUpdates(),
      downloadUpdate: () => autoUpdater.downloadUpdate(),
      // 静默安装，完成后自动重启
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
