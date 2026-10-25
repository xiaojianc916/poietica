import type { LayoutService, PanelItem } from '@poietica/ui-kernel'
import { SquareTerminal } from 'lucide-react'
import type { LazyTerminalRuntime } from './terminal-loader'
import { terminalTabLabel } from './terminal-model'

type DockTabs = NonNullable<PanelItem['dockTabs']>

/**
 * 把终端交给右坞的**页签面**：每条终端是外壳标签条上的一格，与浏览器标签、辅助对话同处一条（不在面板里再套一条标签条）。
 * 加号菜单 / 启动器里的「终端」因此就是「再开一条」。终端是全局的 PTY（不属于哪条对话），所以每个归属的坞看到的是同一组。
 */
export function createTerminalDockTabs({
  layout,
  panelId,
  runtime,
}: {
  readonly layout: LayoutService
  readonly panelId: string
  readonly runtime: LazyTerminalRuntime
}): DockTabs {
  /* 经 openPanel 落到前台的坞上：终端这一格于是总在格清单里，最后一条关掉时 releaseTerminalDock 才撤得掉它、把选中挪走。 */
  const show = (): void => {
    layout.openPanel('right', panelId)
  }

  return {
    subscribe: (listener) => runtime.subscribe(listener),
    tabs: () => {
      const state = runtime.snapshot()

      return state.terminals.map((entry) => ({
        id: entry.id,
        title: terminalTabLabel(entry),
        icon: <SquareTerminal aria-hidden />,
        active: entry.id === state.activeId,
      }))
    },
    onSelect: (id) => {
      runtime.select(id)
      show()
    },
    onClose: (id) => {
      runtime.close(id)
    },
    onOpen: () => {
      runtime.create()
      show()
    },
  }
}

/**
 * 最后一条终端没了：每个停在终端这一格的坞都挪回自己剩下的最后一格，不留一块空的终端面（与子代理组关掉最后一个标签同一个做法）。
 * 格清单里的终端 id 一并撤掉（`openPanel` 会把组 id 记进去）；挪无可挪时坞回到启动器。
 */
export function releaseTerminalDock(layout: LayoutService, panelId: string): void {
  for (const [owner, set] of Object.entries(layout.panes.current().byOwner)) {
    if (set.ids.includes(panelId)) {
      layout.closePane(owner, panelId)
      continue
    }
    if (set.activeId === panelId) {
      const next = set.ids.at(-1)
      if (next !== undefined) layout.focusPane(owner, next)
    }
  }
}

/** 订阅终端数：从有到无的那一刻 releaseTerminalDock。点 ×、「关闭当前终端」、加载失败撤下排队的那一格都走到这里。 */
export function watchLastTerminal(runtime: LazyTerminalRuntime, layout: LayoutService, panelId: string): () => void {
  let last = runtime.count()
  return runtime.subscribe(() => {
    const count = runtime.count()
    if (count === 0 && last > 0) releaseTerminalDock(layout, panelId)
    last = count
  })
}
