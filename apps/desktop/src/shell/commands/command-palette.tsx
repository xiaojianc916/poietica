import {
  CommandMenu,
  type CommandMenuGroup,
  type CommandMenuItem,
  Dialog,
} from '@poietica/design-system'
import type { CommandRegistry, RegisteredCommand } from '@poietica/workspace'
import { ArrowLeft, ArrowRight, Command, PanelLeft, Settings, SquarePen, Zap } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { formatKeybinding } from './keybinding'

interface CommandPaletteProps {
  readonly open: boolean
  readonly registry: CommandRegistry
  readonly onOpenChange: (open: boolean) => void
}

export function CommandPalette({ open, registry, onOpenChange }: CommandPaletteProps) {
  const [query, setQuery] = useState('')

  const commands = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  )

  const groups = useMemo(() => groupCommands(filterCommands(commands, query)), [commands, query])

  useEffect(() => {
    if (open) {
      setQuery('')
    }
  }, [open])

  const executeCommand = (commandId: string) => {
    const command = commands.find((candidate) => candidate.id === commandId)

    if (!command) {
      return
    }

    onOpenChange(false)

    void registry.execute(command.id)
  }

  return (
    <Dialog
      className="max-w-xl rounded-[20px] border-0 shadow-[var(--ui-shadow-lg)]"
      contentClassName="overflow-hidden"
      onOpenChange={onOpenChange}
      open={open}
      /* 表头不画：输入框本身就是标题。名称仍在（Dialog 会渲染成 sr-only）。 */
      showHeader={false}
      title="搜索"
    >
      <CommandMenu
        ariaLabel="搜索聊天与命令"
        groups={groups}
        onQueryChange={setQuery}
        onSelect={executeCommand}
        query={query}
      />
    </Dialog>
  )
}

const CHAT_CATEGORY = '聊天'
const QUICK_CATEGORY = '快捷操作'

const QUICK_ACTION_ICONS: Record<string, ReactNode> = {
  'ai.open-assistant': <SquarePen className="size-4" />,
  'automations.open': <Zap className="size-4" />,
  'application.open-settings': <Settings className="size-4" />,
  'workspace.previous-tab': <ArrowLeft className="size-4" />,
  'workspace.next-tab': <ArrowRight className="size-4" />,
  'workspace.toggle-sidebar': <PanelLeft className="size-4" />,
  'application.toggle-command-palette': <Command className="size-4" />,
}

function filterCommands(
  commands: readonly RegisteredCommand[],
  query: string,
): readonly RegisteredCommand[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()

  if (!normalizedQuery) {
    return commands
  }

  return commands.filter((command) => {
    const searchableText = [command.category ?? '', command.label, command.detail ?? '', command.id]
      .join(' ')
      .toLocaleLowerCase()

    return searchableText.includes(normalizedQuery)
  })
}

function groupCommands(commands: readonly RegisteredCommand[]): readonly CommandMenuGroup[] {
  const chatItems: CommandMenuItem[] = []
  const quickItems: CommandMenuItem[] = []

  for (const command of commands) {
    const base: CommandMenuItem = {
      value: command.id,
      label: command.label,
      ...(command.detail === undefined ? {} : { detail: command.detail }),
    }

    if (command.category === CHAT_CATEGORY) {
      const index = chatItems.length + 1

      chatItems.push({
        ...base,
        ...(index <= 9
          ? { shortcut: formatKeybinding(`Mod+${index}`) }
          : command.shortcut === undefined
            ? {}
            : { shortcut: formatKeybinding(command.shortcut) }),
      })
    } else {
      quickItems.push({
        ...base,
        ...(command.shortcut === undefined ? {} : { shortcut: formatKeybinding(command.shortcut) }),
        icon: QUICK_ACTION_ICONS[command.id],
      })
    }
  }

  const groups: CommandMenuGroup[] = []

  if (chatItems.length > 0) {
    groups.push({ id: CHAT_CATEGORY, title: CHAT_CATEGORY, items: chatItems })
  }

  if (quickItems.length > 0) {
    groups.push({ id: QUICK_CATEGORY, title: QUICK_CATEGORY, items: quickItems })
  }

  return groups
}
