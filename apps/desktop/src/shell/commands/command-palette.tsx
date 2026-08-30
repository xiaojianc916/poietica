import {
  CommandMenu,
  type CommandMenuGroup,
  type CommandMenuItem,
  Dialog,
} from '@poietica/design-system'
import type { CommandRegistry, RegisteredCommand } from '@poietica/workspace'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { formatKeybinding } from './keybinding'

/*
 * 搜索与命令是同一张表。
 *
 * 参照产品里那个弹窗也只有一张：最上面是会话，往下是推荐、设置、导航、面板。
 * 拆成「搜索框」与「命令面板」两个界面，就要有两套过滤、两套键盘导航、两套
 * 空态，而用户按下同一个键期待的是同一个东西。
 *
 * 这一层不认识任何具体命令，只做三件事：按输入过滤、按 category 分组、把选中
 * 的 id 交回注册表执行。分组的先后 = 注册的先后（注册表按注册次序给快照），
 * 所以次序是在 app-commands.ts 那张表里读得出来的，不藏在比较器里。
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
      className="max-w-xl"
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

/** 没有报出类别的命令归这一组，而不是散在别人的组里。 */
const UNGROUPED = '其它'

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
 * 按 category 分组，组序 = 首次出现的先后。
 *
 * Map 保留插入顺序，而注册表给的是注册顺序，所以这里不需要第二份「组该怎么排」
 * 的名单 —— 那种名单一定会和真实的命令表分叉。
 */
function groupCommands(commands: readonly RegisteredCommand[]): readonly CommandMenuGroup[] {
  const held = new Map<string, CommandMenuItem[]>()

  for (const command of commands) {
    const title = command.category ?? UNGROUPED

    const item: CommandMenuItem = {
      value: command.id,
      label: command.label,
      ...(command.detail === undefined ? {} : { detail: command.detail }),
      ...(command.shortcut === undefined ? {} : { shortcut: formatKeybinding(command.shortcut) }),
    }

    const items = held.get(title)

    if (items === undefined) {
      held.set(title, [item])
    } else {
      items.push(item)
    }
  }

  return [...held].map(([title, items]) => ({ id: title, title, items }))
}
