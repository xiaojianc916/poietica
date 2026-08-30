import type { CommandRegistry, WorkbenchSessionStore } from '@poietica/workspace'

/**
 * 应用命令的唯一声明表。
 *
 * id、文案、类别、快捷键与行为都是数据，不是散在 useEffect 里的六次调用：
 * 那种写法把产品文案硬编在生命周期里，effect 依赖也被迫写成整个 runtime 对象，
 * 于是 runtime 任一引用变化都会全量注销再重注册。
 *
 * 注册项类型直接从注册表签名派生，避免这里再养一份会漂移的接口副本。
 */
type CommandRegistration = Parameters<CommandRegistry['register']>[0]

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

/*
 * 这张表的先后 = 面板里的先后。
 *
 * 会话那一组排在它们之前，因为贡献它的组件挂在 AppShell 之内，而 effect
 * 自下而上兑现 —— 这不是巧合，是 React 的兑现次序（见 conversation-commands）。
 */
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
    id: 'application.toggle-command-palette',
    label: '切换命令面板',
    category: '面板',
    shortcut: 'Mod+K',
    execute: (context) => {
      context.toggleCommandPalette()
    },
  },
]

/*
 * 活动标签的前一格与后一格。
 *
 * 「有没有邻居」和「邻居是谁」出自同一次查找，所以两者不可能不一致，两端也
 * 天然不回绕。标题栏的两个箭头（describeTabSequence）与命令面板的
 * workspace.previous-tab／workspace.next-tab 都从它取值。
 */
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

/** 把声明表接上注册表，返回按注册逆序注销的清理函数。 */
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
