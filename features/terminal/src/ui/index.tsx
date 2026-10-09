/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { platformContract } from '@poietica/feature-platform/contract'
import { WorkspacesUiToken } from '@poietica/feature-workspaces/ui-api'
import { builtinPoints, defineUiFeature, type KeybindingItem, LayoutToken, ToastsToken } from '@poietica/ui-kernel'
import { SquareTerminal } from 'lucide-react'
import { createTerminalApi } from './api'
import { TerminalPanel } from './terminal-panel'
import { createTerminalRuntime } from './terminal-store'

import '@xterm/xterm/css/xterm.css'
import './terminal-pane.css'

const PANEL_ID = 'terminal.panel'

/*
 * 终端功能的 UI 装配（07 页 §11E）。
 *
 * **偏差**：07 页 §11E 把终端落在底坞（`location: 'bottom'`），而 legacy 的终端是右坞
 * 四格之一（`auxiliary-panel-store.ts` 的 AUXILIARY_LAUNCHER）。产品负责人要求「UI 与
 * 对话效果必须与 legacy 一模一样」，故以 legacy 为准落 `right`，order 15（辅助对话 5 /
 * 审查 10 / 终端 15 / 浏览器 20）。底坞的基础设施保留但本功能不再使用；已记
 * docs/refactor-log.md。
 *
 * 落点与读法：
 *   panels（bottom, order 10）“终端” —— 命令里开面板，面板里挂 xterm
 *   commands / keybindings —— terminal.new（Ctrl+Shift+`）、terminal.toggle（Ctrl+`）、
 *                             terminal.closeActive、terminal.clear
 *
 * 新建终端的 cwd 取 WorkspacesUiToken.active()?.path ?? null（07 页 §11E 的行为规则），
 * 因此 dependsOn 里必须有 workspaces；面板的开合走内核的 LayoutService。
 *
 * dependsOn 里的 platform 是 §11E「链接」一行的要求（xterm WebLinks → shell.openExternal）：
 * 07 页 §0.1 的终端 UI 依赖表只列了 workspaces，与 §11E 冲突，这里以行为表为准（多声明
 * 一条已存在的依赖，不引入新的契约面）。
 */
export default defineUiFeature({
  id: 'terminal',
  dependsOn: ['workspaces', 'platform'],
  setup(ctx) {
    const layout = ctx.services.get(LayoutToken)
    const toasts = ctx.services.get(ToastsToken)
    const workspaces = ctx.services.get(WorkspacesUiToken)
    const api = createTerminalApi(ctx)
    const platform = ctx.rpc(platformContract)

    const runtime = createTerminalRuntime({
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

    ctx.contribute(builtinPoints.panels, {
      id: PANEL_ID,
      location: 'right',
      order: 15,
      title: '终端',
      icon: SquareTerminal,
      component: () => <TerminalPanel runtime={runtime} />,
    })

    /* 通知按 terminalId 分发到各自的常驻画面上（07 页 §11E 的「输出」一行）。 */
    ctx.lifecycle.onDispose(
      api.onOutput((p) => {
        runtime.writeToHost(p.terminalId, p.data)
      }).dispose,
    )
    ctx.lifecycle.onDispose(
      api.onExited((p) => {
        runtime.markHostExited(p.terminalId, p.exitCode)
      }).dispose,
    )

    /* 重载恢复：渲染进程重新起跑后，Host 里的 PTY 还在（07 页 §11A）。 */
    ctx.lifecycle.onCoreReady(async () => {
      await runtime.restore()
    })

    const newTerminal = (): void => {
      layout.openPanel('right', PANEL_ID)
      runtime.create()
    }

    /* Ctrl+`：切换底坞（收起 → 展开本面板；开着本面板 → 收起）；展开且还没终端时顺手开一个。 */
    const toggle = (): void => {
      const dock = layout.current().right
      const wasOpen = dock.open && dock.activeId === PANEL_ID

      layout.togglePanel('right', PANEL_ID)

      if (!wasOpen && runtime.count() === 0) {
        runtime.create()
      }
    }

    const command = (id: string, title: string, run: () => void, enabled?: () => boolean): void => {
      /* exactOptionalPropertyTypes：没有 enabled 时就不能带这个键 */
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
