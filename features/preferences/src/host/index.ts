import { platformContract } from '@poietica/feature-platform/contract'
import { createJsonDocument } from '@poietica/fs-kit'
import { defineHostModule, HostLoggingToken } from '@poietica/host-kernel'
import { nativeTheme } from 'electron'
import { preferencesContract } from '../contract'
import { Preferences } from '../contract/entities'
import { createKeymapService } from './keymap-service'
import { createPrefsService } from './prefs-service'
import { createUiStateService } from './ui-state-service'
import { WINDOW_BACKGROUND } from './window-colors'

export default defineHostModule({
  id: 'preferences',
  contract: preferencesContract,
  setup(ctx) {
    const doc = createJsonDocument({
      file: ctx.layout.preferencesFile,
      schema: Preferences,
      defaults: () => Preferences.parse({}),
      logger: ctx.logger,
    })
    const uiState = createUiStateService({ file: ctx.layout.uiStateFile, logger: ctx.logger })
    const keymap = createKeymapService({ file: ctx.layout.keymapFile, logger: ctx.logger })
    const logging = ctx.services.get(HostLoggingToken)

    const resolvedTheme = (): 'light' | 'dark' => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')

    /**
     * 日志级别要同步两边：Host 自己 HostLogging.setLevel；Core 为 ready 时调 diagnostics.setLogLevel。
     * 每次 Core 重新进入 ready（崩溃重启后）再同步一次，否则重启后的 Core 会回到默认级别。
     */
    const syncLogLevel = (level: 'debug' | 'info' | 'warn' | 'error'): void => {
      logging.setLevel(level)
      if (ctx.core.status().state === 'ready') {
        void ctx.core.call(platformContract, 'diagnostics.setLogLevel', { level }).catch((e: unknown) => {
          ctx.logger.warn('failed to sync core log level', { error: String(e) })
        })
      }
    }

    const applyEffects = (prev: Preferences | null, next: Preferences): void => {
      nativeTheme.themeSource = next.theme
      ctx.rpc.emit('theme.changed', { resolved: resolvedTheme() })
      if (prev === null || prev.logLevel !== next.logLevel) syncLogLevel(next.logLevel)
      // 主题变化后窗口底色也要跟着走：窗口已存在，configureMain 会拒绝，所以直接设底色
      if (prev === null || prev.theme !== next.theme) {
        const win = ctx.windows.main()
        if (!win.isDestroyed()) {
          win.setBackgroundColor(resolvedTheme() === 'dark' ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light)
        }
      }
    }

    const prefs = createPrefsService({
      doc,
      applyEffects,
      emitChanged: (p) => ctx.rpc.emit('prefs.changed', p),
      logger: ctx.logger,
    })

    // 主题的两个来源：用户选 system 时，Windows 切换深浅色也要重算并广播
    nativeTheme.on('updated', () => {
      ctx.rpc.emit('theme.changed', { resolved: resolvedTheme() })
    })

    // beforeWindow：读偏好并按主题设置窗口底色（深色主题启动没有白闪）
    ctx.lifecycle.beforeWindow(async () => {
      // 三个 JSON 文档都在窗口创建之前读完：窗口一出现，渲染层就可能来取
      await prefs.load()
      await uiState.load()
      await keymap.load()
      const current = prefs.get()
      nativeTheme.themeSource = current.theme
      ctx.windows.configureMain({
        backgroundColor: resolvedTheme() === 'dark' ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light,
      })
      logging.setLevel(current.logLevel)
    })

    ctx.lifecycle.onReady(async () => {
      ctx.rpc.emit('prefs.changed', prefs.get())
      ctx.rpc.emit('theme.changed', { resolved: resolvedTheme() })
      ctx.rpc.emit('keymap.changed', { overrides: keymap.current() })
      ctx.core.onStatus((status) => {
        if (status.state === 'ready') syncLogLevel(prefs.get().logLevel)
      })
    })

    ctx.lifecycle.onShutdown(async () => {
      await uiState.flush()
      await keymap.flush()
      await doc.flush()
    })

    ctx.rpc.handle('prefs.get', () => prefs.get())
    ctx.rpc.handle('prefs.update', async ({ patch }) => prefs.update(patch))
    ctx.rpc.handle('uiState.get', ({ key }) => ({ value: uiState.get(key) }))
    ctx.rpc.handle('uiState.set', ({ key, value }) => {
      uiState.set(key, value)
      return {}
    })
    ctx.rpc.handle('theme.set', async ({ mode }) => {
      await prefs.update({ theme: mode })
      return { resolved: resolvedTheme() }
    })
    ctx.rpc.handle('keymap.get', () => ({ overrides: keymap.current() }))
    ctx.rpc.handle('keymap.set', ({ commandId, key }) => {
      const overrides = keymap.set(commandId, key)
      ctx.rpc.emit('keymap.changed', { overrides })
      return { overrides }
    })
    ctx.rpc.handle('keymap.reset', () => {
      const overrides = keymap.reset()
      ctx.rpc.emit('keymap.changed', { overrides })
      return { overrides }
    })
  },
})
