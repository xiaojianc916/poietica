/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { platformContract } from '@poietica/feature-platform/contract'
import { WorkspacesUiToken } from '@poietica/feature-workspaces/ui-api'
import { builtinPoints, defineUiFeature, type KeybindingItem, LayoutToken, ToastsToken } from '@poietica/ui-kernel'
import { SquareTerminal } from 'lucide-react'
import { lazy } from 'react'
import { createTerminalApi } from './api'
import { createLazyTerminalRuntime } from './terminal-loader'

const PANEL_ID = 'terminal.panel'

/* 终端功能的 UI 装配。**偏差**：方案把终端落在底坞，而 legacy 的终端是右坞四格之一；产品负责人要求「UI 与对话效果必须与 legacy
 * 一模一样」，故以 legacy 为准落 `right`、order 15。已记 docs/refactor-log.md。落点：panels(right, order 15)「终端」；commands /
 * keybindings —— terminal.new（Ctrl+Shift+`）、terminal.toggle（Ctrl+`）、terminal.closeActive、terminal.clear。 */
export default defineUiFeature({
  id: 'terminal',
  dependsOn: ['workspaces', 'platform'],
  setup(ctx) {
    const layout = ctx.services.get(LayoutToken)
    const toasts = ctx.services.get(ToastsToken)
    const workspaces = ctx.services.get(WorkspacesUiToken)
    const api = createTerminalApi(ctx)
    const platform = ctx.rpc(platformContract)

    const runtime = createLazyTerminalRuntime({
      api,
      logger: ctx.logger,
      cwd: () => workspaces.active()?.path ?? null,
      openExternal: (url) => {
        void platform.call('shell.openExternal', { url }).catch((cause: unknown) => {
          toasts.error(cause, '链接没能打开')
        })
      },
      onError: (error, title) => {
        toasts.error(error, title)
      },
    })

    const TerminalPanelLazy = lazy(async () => {
      const [loaded, { TerminalPanel }] = await Promise.all([runtime.load(), import('./terminal-panel')])
      return { default: () => <TerminalPanel runtime={loaded} /> }
    })

    ctx.contribute(builtinPoints.panels, {
      id: PANEL_ID,
      location: 'right',
      order: 15,
      title: '终端',
      icon: SquareTerminal,
      component: TerminalPanelLazy,
    })

    ctx.lifecycle.onDispose(
      api.onOutput((p) => {
        runtime.writeToHost(p.terminalId, p.data, p.offset)
      }).dispose,
    )
    ctx.lifecycle.onDispose(
      api.onExited((p) => {
        runtime.markHostExited(p.terminalId, p.exitCode)
      }).dispose,
    )

    /* 渲染进程重新起跑后，Host 里的 PTY 还在。 */
    ctx.lifecycle.onCoreReady(async () => {
      await runtime.restore()
    })

    const newTerminal = (): void => {
      layout.openPanel('right', PANEL_ID)
      runtime.create()
    }

    /* Ctrl+`：收起 → 展开本面板；开着本面板 → 收起。展开且还没终端时顺手开一个。 */
    const toggle = (): void => {
      const dock = layout.current().right
      const wasOpen = dock.open && dock.activeId === PANEL_ID

      layout.togglePanel('right', PANEL_ID)

      if (!wasOpen && runtime.count() === 0) {
        runtime.create()
      }
    }

    const command = (id: string, title: string, run: () => void, enabled?: () => boolean): void => {
      ctx.contribute(
        builtinPoints.commands,
        enabled === undefined ? { id, title, category: '终端', run } : { id, title, category: '终端', run, enabled },
      )
    }
    command('terminal.new', '新建终端', newTerminal)
    command('terminal.toggle', '切换终端面板', toggle)
    command(
      'terminal.closeActive',
      '关闭当前终端',
      () => {
        runtime.closeActive()
      },
      () => runtime.count() > 0,
    )
    command(
      'terminal.clear',
      '清屏',
      () => {
        runtime.clearActive()
      },
      () => runtime.count() > 0,
    )

    const bind = (command_: string, key: string): void => {
      ctx.contribute(builtinPoints.keybindings, { command: command_, key } satisfies KeybindingItem)
    }
    bind('terminal.new', 'Ctrl+Shift+`')
    bind('terminal.toggle', 'Ctrl+`')

    ctx.lifecycle.onDispose(() => {
      runtime.dispose()
    })
  },
})
