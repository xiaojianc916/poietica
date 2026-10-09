import { cn } from '@poietica/design-system'
import { useFeatureStore } from '@poietica/ui-kernel'
import { Plus, X } from 'lucide-react'
import { type ReactNode, useEffect } from 'react'
import { type TerminalEntry, type TerminalRuntime, terminalTabLabel } from './terminal-store'
import { TerminalView } from './terminal-view'

/**
 * 终端面板（07 页 §11E）：标签条（`title • 序号`、已退出变灰、`+` 新建、每个标签
 * 的 `×` 关闭）＋ 主体 xterm 视图。
 *
 * **外观以 legacy 为准**（legacy `packages/terminal/src/surface/terminal-pane.tsx`）：
 *   1. 打开这一格就先开一条终端 —— legacy 的 TerminalPane 在挂载那一刻就 attach，
 *      用户点「终端」看到的是一块能敲的 shell，而不是一块空面板加一枚加号；
 *   2. 只有一条终端时不画标签条 —— legacy 每格只有一条终端，那一行本来就不存在；
 *      它与 `+` 只在用户真的开出第二条之后才出现（07 页 §11E 的新能力，视觉词汇
 *      沿用外壳的面板标签条：workbench 的 TabStrip，迁移自 legacy auxiliary-tab-strip）。
 *
 * 这一格只在用户真的打开它之后才挂载（坞的归属语义：owner 存在且在才渲染），所以
 * 下面的自动新建不会凭空开出一条 PTY。
 */
export function TerminalPanel({ runtime }: { readonly runtime: TerminalRuntime }): ReactNode {
  const terminals = useFeatureStore(runtime.store, (s) => s.terminals)
  const activeId = useFeatureStore(runtime.store, (s) => s.activeId)

  useEffect(() => {
    if (runtime.count() === 0) {
      runtime.create()
    }
  }, [runtime])

  return (
    <div className="flex h-full min-h-0 flex-col" data-terminal-panel="">
      {terminals.length <= 1 ? null : (
        <div aria-label="终端" className="flex min-h-9 shrink-0 items-center gap-1 px-2" role="tablist">
          {terminals.map((entry) => (
            <TerminalTab
              active={entry.id === activeId}
              entry={entry}
              key={entry.id}
              onClose={() => {
                runtime.close(entry.id)
              }}
              onSelect={() => {
                runtime.select(entry.id)
                runtime.session(entry.id)?.focus()
              }}
            />
          ))}
          <button
            aria-label="新建终端"
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-tab-hover hover:text-foreground"
            onClick={() => {
              runtime.create()
            }}
            title="新建终端"
            type="button"
          >
            <Plus aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {terminals.map((entry) => {
          const session = runtime.session(entry.id)

          return session === undefined ? null : (
            <TerminalView active={entry.id === activeId} key={entry.id} session={session} />
          )
        })}
      </div>
    </div>
  )
}

function TerminalTab({
  entry,
  active,
  onSelect,
  onClose,
}: {
  readonly entry: TerminalEntry
  readonly active: boolean
  readonly onSelect: () => void
  readonly onClose: () => void
}): ReactNode {
  const exited = entry.info?.exited === true

  return (
    <button
      aria-selected={active}
      className={cn(
        'flex min-h-7 max-w-44 min-w-16 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors',
        active ? 'bg-tab-active text-foreground' : 'text-muted-foreground hover:bg-tab-hover',
        exited && 'opacity-60',
      )}
      onClick={(event) => {
        if ((event.target as Element).closest('[data-close-tab]') !== null) {
          onClose()
          return
        }
        onSelect()
      }}
      onPointerDown={(event) => {
        if ((event.target as Element).closest('[data-close-tab]') !== null) {
          event.preventDefault()
        }
      }}
      role="tab"
      tabIndex={active ? 0 : -1}
      type="button"
    >
      <span className="min-w-0 truncate">{terminalTabLabel(entry)}</span>
      <span
        aria-hidden="true"
        className="grid size-3.5 shrink-0 place-items-center rounded-sm opacity-60 hover:opacity-100"
        data-close-tab=""
        title="关闭终端"
      >
        <X className="size-3" />
      </span>
    </button>
  )
}
