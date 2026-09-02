import type { PlanItem } from '@poietica/conversation'

const ENTRY_LABELS: Record<string, string> = {
  completed: '已完成',
  in_progress: '进行中',
  pending: '待办',
}

/**
 * The plan the agent is working to.
 *
 * Replaced wholesale every time the agent revises it, so this draws the current
 * plan and keeps no memory of earlier ones.
 */
export function PlanPanel({ entries }: { readonly entries: PlanItem['entries'] }) {
  return (
    <ol className="timeline-plan">
      {entries.map((entry) => (
        <li className="timeline-plan__entry" data-status={entry.status} key={entry.content}>
          <span className="timeline-plan__status">
            {ENTRY_LABELS[entry.status] ?? entry.status}
          </span>
          <span className="timeline-plan__content">{entry.content}</span>
        </li>
      ))}
    </ol>
  )
}
