import { CommandMenu, type CommandMenuGroup, type CommandMenuItem, Dialog } from '@poietica/design-system'
import { builtinPoints, useContributions, useKernel, useObservable } from '@poietica/ui-kernel'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { fuzzyScore } from '../fuzzy'

/**
 * 命令面板。**迁移自** legacy `shell/commands/command-palette.tsx`：
 * 用 design-system 的 Dialog + CommandMenu（legacy 同此），不再自己画输入框与列表 ——
 * 高亮、跨组导航、Home/End、Enter 选中、active-descendant 语义都归 Base UI。
 *
 * 只换数据来源：legacy 读 CommandRegistry，这里读 commands 贡献点 + 内核的
 * keybindings 服务。分组、过滤、最近 5 条的行为照旧（06 页 §6.4）。
 */
export function CommandPalette({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }): ReactNode {
  const { kernelServices } = useKernel()
  const commands = useContributions(builtinPoints.commands)
  const overrides = useObservable(kernelServices.keybindings)
  const [query, setQuery] = useState('')
  const [recent, setRecent] = useState<readonly string[]>([])

  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  const groups = useMemo<readonly CommandMenuGroup[]>(() => {
    void overrides // 改键后行尾的按键要立即刷新

    const visible = commands.filter((c) => c.item.hidden !== true).filter((c) => c.item.enabled?.() !== false)

    const keyOf = (id: string): string | undefined => kernelServices.keybindings.keyFor(id) ?? undefined

    const scored =
      query.trim() === ''
        ? visible
        : visible
            .map((c) => ({ c, score: fuzzyScore(query, `${c.item.category ?? ''} ${c.item.title}`) }))
            .filter((x) => x.score >= 0)
            .sort(
              (a, b) =>
                b.score - a.score || (a.c.item.title < b.c.item.title ? -1 : a.c.item.title > b.c.item.title ? 1 : 0),
            )
            .map((x) => x.c)

    if (query.trim() === '') {
      // 最近执行的 5 条在输入为空时置顶（06 页 §6.4）
      const byId = new Map(scored.map((c) => [c.item.id, c]))
      const recentItems = recent.map((id) => byId.get(id)).filter((c) => c !== undefined)
      scored.splice(0, scored.length, ...recentItems, ...scored.filter((c) => !recent.includes(c.item.id)))
    }

    const byCategory = new Map<string, CommandMenuItem[]>()
    for (const c of scored) {
      const title = c.item.category ?? '命令'
      const list = byCategory.get(title) ?? []
      const shortcut = keyOf(c.item.id)
      list.push({
        value: c.item.id,
        label: c.item.title,
        ...(c.item.category === undefined ? {} : { detail: c.item.id }),
        ...(shortcut === undefined ? {} : { shortcut }),
      })
      byCategory.set(title, list)
    }

    return [...byCategory].map(([title, items]) => ({ id: title, title, items }))
  }, [commands, query, recent, kernelServices, overrides])

  const execute = (id: string): void => {
    onClose()
    setRecent((prev) => [id, ...prev.filter((x) => x !== id)].slice(0, 5))
    void kernelServices.commands.execute(id)
  }

  return (
    <Dialog
      className="max-w-xl rounded-[20px] border-0 shadow-[var(--ui-shadow-lg)]"
      contentClassName="overflow-hidden"
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      open={open}
      /* 表头不画：输入框本身就是标题。名称仍在（Dialog 渲染成 sr-only）。 */
      showHeader={false}
      title="搜索"
    >
      <CommandMenu
        ariaLabel="搜索命令"
        groups={groups}
        onQueryChange={setQuery}
        onSelect={execute}
        placeholder="搜索命令"
        query={query}
      />
    </Dialog>
  )
}
