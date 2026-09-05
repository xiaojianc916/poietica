import { type Automation, describeMoment, isTerminal, RUN_LABELS } from '@poietica/automation'

export interface AutomationRunHistoryProps {
  readonly runs: Automation['runs']
  readonly title: string
  readonly onOpenThread: (threadId: string, title: string) => void
  readonly onCancel: (runId: string) => void
}

export function AutomationRunHistory({
  runs,
  title,
  onOpenThread,
  onCancel,
}: AutomationRunHistoryProps) {
  if (runs.length === 0) {
    return <p className="py-10 text-center text-xs text-muted-foreground">暂无运行历史</p>
  }
  return (
    <div>
      <p className="mb-3 text-xs text-muted-foreground">
        这里只显示保留的最近运行记录；对话正文单独保留。
      </p>
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
              dateTime={run.startedAt}
              title={new Date(run.startedAt).toLocaleString()}
            >
              {describeMoment(run.startedAt)}
            </time>
            {!isTerminal(run.outcome) ? (
              <button
                className="rounded px-2 py-1 hover:bg-sidebar-accent"
                disabled={run.outcome === 'cancelling'}
                onClick={() => onCancel(run.id)}
                type="button"
              >
                {run.outcome === 'cancelling' ? '等待停止确认' : '停止'}
              </button>
            ) : null}
            {run.message ? (
              <p className="w-full break-words text-muted-foreground">{run.message}</p>
            ) : null}
            {run.settledAt ? (
              <p className="w-full text-muted-foreground">
                结束于 {new Date(run.settledAt).toLocaleString()}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
