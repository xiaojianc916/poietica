import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '@poietica/foundation'
import { defineHostModule } from '@poietica/host-kernel'
import { app, ClipboardItem, clipboard, dialog } from 'electron'
import { INTELLIGENT_UI_ASSET_HOST, intelligentUiContract, intelligentUiErrors } from '../contract'
import { captureRectOf, clipboardFailureOf } from './capture'
import { exportFileNameOf, standaloneHtml } from './export'
import { createShellHandler } from './shell'

/*
 * intelligent-ui 的 Host 半边：
 * - 资源协议 poietica-asset://intelligent-ui/…：外壳文档与随包库（shell.ts）；
 * - 「复制为图片」：截主窗口里界面那一块（capture.ts）—— 跨源 iframe 的像素只有 Host 拿得到；
 * - 「导出 HTML」：保存对话框 + 写一个独立文件（export.ts）。
 */
export default defineHostModule({
  id: 'intelligent-ui',
  contract: intelligentUiContract,
  setup(ctx) {
    ctx.assets.register(INTELLIGENT_UI_ASSET_HOST, createShellHandler())

    ctx.rpc.handle('intelligentUi.copyImage', async ({ rect }) => {
      const win = ctx.windows.main()
      const [width = 0, height = 0] = win.getContentSize()
      const area = captureRectOf(rect, win.webContents.getZoomFactor(), { width, height })
      if (area === null) throw new AppError(intelligentUiErrors.capture_failed, '界面不在窗口的可见区域里')
      const image = await win.webContents.capturePage(area)
      if (image.isEmpty()) throw new AppError(intelligentUiErrors.capture_failed, '截到的是空图')
      /* Electron 44 起剪贴板是 W3C 式的异步接口：图片按 image/png 的 Blob 写 */
      const png = new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' })
      try {
        await clipboard.write([new ClipboardItem({ 'image/png': png })])
      } catch (cause) {
        /* 不吞底层异常：原样进日志，用户看到稳定的业务错误码 */
        ctx.logger.warn('intelligent ui clipboard write failed', { error: String(cause) })
        throw clipboardFailureOf(cause)
      }
      return {}
    })

    ctx.rpc.handle('intelligentUi.exportHtml', async (params) => {
      const result = await dialog.showSaveDialog(ctx.windows.main(), {
        defaultPath: path.join(app.getPath('downloads'), exportFileNameOf(params.title)),
        filters: [{ name: 'HTML', extensions: ['html'] }],
      })
      if (result.canceled || result.filePath === undefined || result.filePath === '') return { path: null }
      const filePath = result.filePath
      try {
        await writeFile(filePath, standaloneHtml(params), 'utf8')
      } catch (cause) {
        ctx.logger.warn('intelligent ui export failed', { title: params.title, path: filePath, error: String(cause) })
        throw new AppError(intelligentUiErrors.export_failed, '没能导出界面文件', { cause: String(cause) })
      }
      return { path: filePath }
    })
  },
})
