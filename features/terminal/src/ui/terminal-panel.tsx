import { Button } from '@poietica/design-system'
import { type ReactNode, useSyncExternalStore } from 'react'
import type { LazyTerminalRuntime } from './terminal-loader'
import { TerminalView } from './terminal-view'

/**
 * 右坞「终端」那一格的主体。每条终端是右坞标签条上的一格（见 terminal-dock-tabs.tsx），这里只画选中那一条的画面，其余留在 DOM 里藏着
 * —— 后台终端的输出照样写进它自己的画面，切回来时不缺内容。
 *
 * 这一格**静态**进首屏，不再 `lazy(等 xterm)`：以前打开时外壳拿 Suspense 的兜底灰块（`--ui-muted` 40% 叠在 #181818 上，正是 #212121）
 * 顶着，等 420KB 的 xterm 分块到了才换成 #181818 的终端底。现在第一帧就是终端自己的底色，xterm 到了只是往上画字。
 */
export function TerminalPanel({ runtime }: { readonly runtime: LazyTerminalRuntime }): ReactNode {
  const state = useSyncExternalStore(runtime.subscribe, runtime.snapshot)

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--terminal-background)]" data-terminal-panel="">
      {state.terminals.length === 0 ? (
        /* 坞停在终端这一格、却一条终端都没有：只有重启后恢复出来的布局会这样（关掉最后一条时坞会自己挪走）。不替用户开 PTY。 */
        <div className="m-auto grid justify-items-center gap-3 px-6 text-center">
          <p className="text-xs text-muted-foreground">没有打开的终端</p>
          <Button
            onClick={() => {
              runtime.create()
            }}
            size="xs"
            variant="soft"
          >
            新建终端
          </Button>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {state.terminals.map((entry) => {
            const session = runtime.session(entry.id)

            /* 加载前排队的那几格还没有画面：底色已经是终端的，xterm 到了再补上。 */
            return session === undefined ? null : (
              <TerminalView active={entry.id === state.activeId} key={entry.id} session={session} />
            )
          })}
        </div>
      )}
    </div>
  )
}
