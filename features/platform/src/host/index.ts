import { statSync } from 'node:fs'
import { BROWSER_PARTITION } from '@poietica/feature-browser/contract'
import { defineHostModule } from '@poietica/host-kernel'
import { type BrowserWindow, dialog, Notification, screen, session, shell } from 'electron'
import { platformContract } from '../contract'
import { createLogSink } from './log-sink'
import { createNotifyService } from './notify-service'
import { createShellService } from './shell-service'
import { createStorageService } from './storage-service'
import { WINDOW_BACKGROUND } from './window-colors'
import { createWindowStateStore } from './window-state'

/** 目标路径存在且是文件或目录 */
function pathExists(p: string): boolean {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

export default defineHostModule({
  id: 'platform',
  contract: platformContract,
  setup(ctx) {
    const shellService = createShellService({ shell, exists: pathExists })
    const logSink = createLogSink(ctx.logger)
    const windowState = createWindowStateStore({
      file: ctx.layout.windowStateFile,
      logger: ctx.logger,
      workAreas: () => screen.getAllDisplays().map((display) => display.workArea),
    })
    const notify = createNotifyService({
      isMainFocused: () => ctx.windows.main().isFocused(),
      focusMain: () => ctx.windows.focusMain(),
      createNotification: (o) => new Notification({ title: o.title, body: o.body, silent: o.silent ?? false }),
      emitClicked: (threadId) => ctx.rpc.emit('notify.clicked', { threadId }),
    })
    const storage = createStorageService({
      layout: ctx.layout,
      clearDefaultSessionCache: async () => {
        await session.defaultSession.clearCache()
      },
      browserSession: {
        clearCache: async () => {
          await session.fromPartition(BROWSER_PARTITION).clearCache()
        },
        clearStorageData: async () => {
          await session.fromPartition(BROWSER_PARTITION).clearStorageData()
        },
      },
    })

    // ── 窗口位置：beforeWindow 恢复，onReady 里监听变化 ──────────────
    ctx.lifecycle.beforeWindow(async () => {
      const saved = await windowState.load()
      ctx.windows.configureMain({
        // exactOptionalPropertyTypes：x/y 缺席时不要显式写 undefined
        bounds: {
          ...(saved.bounds.x === undefined ? {} : { x: saved.bounds.x }),
          ...(saved.bounds.y === undefined ? {} : { y: saved.bounds.y }),
          width: saved.bounds.width,
          height: saved.bounds.height,
        },
        maximized: saved.maximized,
        backgroundColor: WINDOW_BACKGROUND.light,
      })
    })
    ctx.lifecycle.onReady(() => {
      const win = ctx.windows.main()
      const save = (): void => {
        windowState.save({ bounds: win.getNormalBounds(), maximized: win.isMaximized() })
      }
      win.on('resize', save)
      win.on('move', save)
      win.on('maximize', () => {
        save()
        ctx.rpc.emit('window.maximizedChanged', { maximized: true })
      })
      win.on('unmaximize', () => {
        save()
        ctx.rpc.emit('window.maximizedChanged', { maximized: false })
      })
      // 关闭拦截：已在退出中 → 放行；渲染进程无响应或已崩溃 → 直接退出（否则用户永远关不掉窗口）；
      // 其余 → preventDefault 并通知 UI（UI 确认完自己调用 app.quit）
      win.on('close', (event) => {
        if (ctx.app.quitting()) return
        if (!ctx.windows.isMainResponsive() || win.webContents.isCrashed()) {
          void ctx.app.quit()
          return
        }
        event.preventDefault()
        ctx.rpc.emit('window.closeRequested', {})
      })
    })
    ctx.lifecycle.onShutdown(async () => {
      await windowState.flush()
    })

    // ── 方法 ────────────────────────────────────────────────────────
    ctx.rpc.handle('app.info', () => ({
      version: ctx.appVersion,
      isPackaged: ctx.isPackaged,
      dataRoot: ctx.layout.root,
      platform: 'win32' as const,
    }))
    ctx.rpc.handle('app.quit', async () => {
      await ctx.app.quit()
      return {}
    })

    ctx.rpc.handle('window.minimize', () => {
      ctx.windows.main().minimize()
      return {}
    })
    ctx.rpc.handle('window.toggleMaximize', () => {
      const win = ctx.windows.main()
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
      return {}
    })
    ctx.rpc.handle('window.close', () => {
      ctx.windows.main().close()
      return {}
    })
    ctx.rpc.handle('window.openDevtools', () => {
      ctx.windows.main().webContents.openDevTools({ mode: 'detach' })
      return {}
    })
    ctx.rpc.handle('window.isMaximized', () => ({ maximized: ctx.windows.main().isMaximized() }))

    const mainWindow = (): BrowserWindow => ctx.windows.main()
    ctx.rpc.handle('dialog.pickFolder', async ({ title }) => {
      const result = await dialog.showOpenDialog(mainWindow(), {
        ...(title === undefined ? {} : { title }),
        properties: ['openDirectory', 'createDirectory'] as const,
      })
      return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
    })
    ctx.rpc.handle('dialog.pickFiles', async ({ filters, multiple }) => {
      const result = await dialog.showOpenDialog(mainWindow(), {
        properties: ['openFile', ...(multiple ? (['multiSelections'] as const) : [])],
        ...(filters === undefined
          ? {}
          : { filters: filters.map((f) => ({ name: f.name, extensions: [...f.extensions] })) }),
      })
      return { paths: result.canceled ? [] : result.filePaths }
    })
    ctx.rpc.handle('dialog.pickSavePath', async ({ defaultName, filters }) => {
      const result = await dialog.showSaveDialog(mainWindow(), {
        defaultPath: defaultName,
        ...(filters === undefined
          ? {}
          : { filters: filters.map((f) => ({ name: f.name, extensions: [...f.extensions] })) }),
      })
      return { path: result.canceled ? null : (result.filePath ?? null) }
    })

    ctx.rpc.handle('shell.openExternal', async ({ url }) => {
      await shellService.openExternal(url)
      return {}
    })
    ctx.rpc.handle('shell.openPath', async ({ path: p }) => {
      await shellService.openPath(p)
      return {}
    })
    ctx.rpc.handle('shell.showInFolder', ({ path: p }) => {
      shellService.showInFolder(p)
      return {}
    })
    ctx.rpc.handle('shell.trashItem', async ({ path: p }) => {
      await shellService.trashItem(p)
      return {}
    })

    ctx.rpc.handle('notify.show', ({ title, body, threadId }) => {
      notify.show({ title, body, ...(threadId === undefined ? {} : { threadId }) })
      return {}
    })

    ctx.rpc.handle('log.write', ({ entries }) => {
      logSink.write(entries)
      return {}
    })

    ctx.rpc.handle('storage.usage', async () => ({ entries: await storage.report() }))
    ctx.rpc.handle('storage.clear', async ({ target }) => storage.clear(target))
    ctx.rpc.handle('storage.openDataFolder', async () => {
      await shellService.openPath(ctx.layout.root)
      return {}
    })
  },
})
