import type { Automation } from '@poietica/native-bridge'
import { cn } from '@poietica/ui'

import { describeMoment } from '../automation'

/**
 * 这条自动化跑过的那些次。
 *
 * 账本只留最近若干条，上限由持有账本的那一侧决定；再往前的正文仍在各自那条对话
 * 里 —— 这一层不复述运行内容，会话才是唯一中心。
 *
 * 还不能点进那次对话：openConversation 在工作台的命令面上，这一层够不着。为了一
 * 块界面去拓宽组合根的签名，顺序是反的 —— 那一步单独做。
 */

export interface AutomationRunHistoryProps {
  readonly runs: Automation['runs']
}

export function AutomationRunHistory({ runs }: AutomationRunHistoryProps) {
  if (runs.length === 0) {
    return <p className="py-10 text-center text-xs text-muted-foreground">暂无运行历史</p>
  }

  return (
    <ul className="divide-y divide-divider/60 overflow-hidden rounded-xl border border-divider bg-background">
      {runs.map((run) => (
        <li
          className="flex items-center gap-3 px-4 py-2.5 text-xs"
          key={run.startedAt + (run.threadId ?? '')}
        >
          {/* 圆点只画结果这一件事，颜色之外不承载信息，所以 aria-hidden：
              旁边那两个字已经把同一件事说清楚了，读屏不必听两遍。 */}
          <span
            aria-hidden="true"
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              run.outcome === 'succeeded' ? 'bg-foreground/40' : 'bg-destructive',
            )}
          />

          <span className={run.outcome === 'succeeded' ? '' : 'text-destructive'}>
            {run.outcome === 'succeeded' ? '成功' : '失败'}
          </span>

          <span className="truncate text-muted-foreground">
            {run.threadId === null ? '没有留下对话' : '留下了一条对话'}
          </span>

          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
            {describeMoment(run.startedAt)}
          </span>
        </li>
      ))}
    </ul>
  )
}
