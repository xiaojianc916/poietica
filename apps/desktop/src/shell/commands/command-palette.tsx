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

/*
 * 搜索与命令是同一张表。
 *
 * 拆成「搜索框」与「命令面板」两个界面，就要有两套过滤、两套键盘导航、两套
 * 空态，而用户按下同一个键期待的是同一个东西。
 *
 * 这一层不认识任何具体命令，只做三件事：按输入过滤、折叠成「聊天 / 快捷操作」
 * 两组、把选中的 id 交回注册表执行。组内次序 = 注册的先后（注册表按注册次序
 * 给快照），所以次序是在 app-commands.ts 那张表里读得出来的，不藏在比较器里。
 */

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

/*
 * 面板只分两组：会话是「聊天」，其余一切动作收进「快捷操作」。
 *
 * 注册表里的 category（推荐/设置/导航/面板）是命令的语义分类，不是面板的视觉
 * 分组——语义类别有六七个时，面板里就会出现六七个各两条的碎组，扫一眼找不到
 * 东西。这里把非会话命令全部折叠进一组，组内次序仍 = 注册次序。
 */
const CHAT_CATEGORY = '聊天'
const QUICK_CATEGORY = '快捷操作'

/**
 * 快捷操作的行首图标。
 *
 * 图标是纯展示知识，不进 RegisteredCommand——命令注册表不认识 React，也不该
 * 因为换了个图标库而变。这里按 id 查表，未命中就不画（退化成纯文字行）。
 */
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

/*
 * 两组固定：聊天在前，快捷操作在后。
 *
 * 聊天项按显示顺序给前 9 条编 Ctrl+1…Ctrl+9——这只是面板里的速选标签，不是
 * 全局快捷键（全局快捷键由命令自身的 shortcut 声明，走 keybinding.ts）。编号
 * 随过滤结果重排，因此永远指向"屏幕上的第 N 条"。
 */
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
