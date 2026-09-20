import type { CommandRegistry, WorkbenchSessionStore } from '@poietica/workspace'

type CommandRegistration = Parameters<CommandRegistry['register']>[0]

export const TOGGLE_COMMAND_PALETTE_COMMAND_ID = 'application.toggle-command-palette'

export interface ApplicationCommandContext {
  readonly workspace: WorkbenchSessionStore
  readonly toggleCommandPalette: () => void
  readonly openAssistantSurface: () => void
  readonly openSettings: () => void
  readonly toggleSidebar: () => void
}

type ApplicationCommand = Omit<CommandRegistration, 'execute'> & {
  readonly execute: (context: ApplicationCommandContext) => void
}

/* 表内先后 = 面板内先后；会话组排最前，因贡献它的组件挂在 AppShell 内、effect 自下而上先兑现（见 workbench/connections）。 */
const APPLICATION_COMMANDS: readonly ApplicationCommand[] = [
  {
    id: 'ai.open-assistant',
    label: '新建对话',
    category: '推荐',
    shortcut: 'Mod+J',
    execute: (context) => {
      context.openAssistantSurface()
    },
  },
  {
    id: 'automations.open',
    label: '打开自动化',
    category: '推荐',
    execute: (context) => {
      context.workspace.openSurface({ surfaceId: 'automations' })
    },
  },
  {
    id: 'application.open-settings',
    label: '设置',
    category: '设置',
    shortcut: 'Mod+,',
    execute: (context) => {
      context.openSettings()
    },
  },
  {
    id: 'workspace.previous-tab',
    label: '上一个标签页',
    category: '导航',
    shortcut: 'Mod+Shift+[',
    execute: (context) => {
      stepTab(context.workspace, -1)
    },
  },
  {
    id: 'workspace.next-tab',
    label: '下一个标签页',
    category: '导航',
    shortcut: 'Mod+Shift+]',
    execute: (context) => {
      stepTab(context.workspace, 1)
    },
  },
  {
    id: 'workspace.toggle-sidebar',
    label: '切换侧边栏',
    category: '面板',
    shortcut: 'Mod+B',
    execute: (context) => {
      context.toggleSidebar()
    },
  },
  {
    id: TOGGLE_COMMAND_PALETTE_COMMAND_ID,
    label: '切换命令面板',
    category: '面板',
    shortcut: 'Mod+K',
    execute: (context) => {
      context.toggleCommandPalette()
    },
  },
]

export function tabNeighbors<T extends { readonly id: string }>(
  tabs: readonly T[],
  activeTabId: string | undefined,
): { readonly previous: T | undefined; readonly next: T | undefined } {
  const index = activeTabId === undefined ? -1 : tabs.findIndex((tab) => tab.id === activeTabId)

  return {
    previous: index > 0 ? tabs[index - 1] : undefined,
    next: index >= 0 && index < tabs.length - 1 ? tabs[index + 1] : undefined,
  }
}

function stepTab(workspace: WorkbenchSessionStore, step: number): void {
  const { tabs, activeTabId } = workspace.getSnapshot()
  const { next, previous } = tabNeighbors(tabs, activeTabId)
  const target = step < 0 ? previous : next

  if (target !== undefined) {
    workspace.activateTab(target.id)
  }
}

export function registerApplicationCommands(
  registry: CommandRegistry,
  context: ApplicationCommandContext,
): () => void {
  const unregister = APPLICATION_COMMANDS.map(({ execute, ...declaration }) =>
    registry.register({
      ...declaration,
      execute: () => {
        execute(context)
      },
    }),
  )

  return () => {
    for (let index = unregister.length - 1; index >= 0; index -= 1) {
      unregister[index]?.()
    }
  }
}
