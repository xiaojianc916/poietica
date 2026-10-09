import type { AutomationRun } from '../contract'
import { describeMoment, isTerminal, RUN_LABELS } from './automation'

/*
 * 照 legacy `packages/automation/src/ui/automation-run-history.tsx` 逐字搬迁。
 * 两处随契约变：时间从 ISO 字符串变成毫秒数（describeMoment 直接收 number）；
 * outcome 是契约里的五个值（running / awaiting / succeeded / failed / cancelled），
 * legacy 的 queued / dispatching / cancelling / uncertain 四档随 Rust 运行态一起取消，
 * 因此这里只在 running 与 awaiting 上给「停止」。
 */

export interface AutomationRunHistoryProps {
  readonly runs: readonly AutomationRun[]
  readonly title: string
  readonly onOpenThread: (threadId: string, title: string) => void
  readonly onCancel: (runId: string) => void
}

export function AutomationRunHistory({ runs, title, onOpenThread, onCancel }: AutomationRunHistoryProps) {
  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-divider px-6 py-28">
        <p className="text-xs text-muted-foreground">没有运行记录</p>
      </div>
    )
  }
  return (
    <div>
      <p className="mb-3 text-xs text-muted-foreground">这里只显示保留的最近运行记录；对话正文单独保留。</p>
      <ul className="divide-y divide-divider/60 overflow-hidden rounded-xl border border-divider bg-background">
        {runs.map((run) => (
          <li className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs" key={run.id}>
            <span className={run.outcome === 'failed' ? 'text-destructive' : 'text-foreground'}>
              {RUN_LABELS[run.outcome]}
            </span>
            {run.threadId === null ? (
              <span className="text-muted-foreground">没有关联对话</span>
            ) : (
              <button
                className="hover:underline"
                onClick={() => {
                  if (run.threadId !== null) {
                    onOpenThread(run.threadId, title)
                  }
                }}
                type="button"
              >
                打开对话
              </button>
            )}
            <time
              className="ml-auto text-muted-foreground"
              dateTime={new Date(run.startedAt).toISOString()}
              title={new Date(run.startedAt).toLocaleString()}
            >
              {describeMoment(run.startedAt)}
            </time>
            {!isTerminal(run.outcome) ? (
              <button
                className="rounded px-2 py-1 hover:bg-sidebar-accent"
                onClick={() => onCancel(run.id)}
                type="button"
              >
                停止
              </button>
            ) : null}
            {run.message ? <p className="w-full break-words text-muted-foreground">{run.message}</p> : null}
            {run.settledAt ? (
              <p className="w-full text-muted-foreground">结束于 {new Date(run.settledAt).toLocaleString()}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
