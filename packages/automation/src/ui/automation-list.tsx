import {
  type Automation,
  type AutomationStore,
  activeRun,
  describeMoment,
  describeSchedule,
  latestRun,
  RUN_LABELS,
} from '@poietica/automation'
import { ConfirmationDialog } from '@poietica/design-system'
import { useState } from 'react'

export interface AutomationListProps {
  readonly automations: readonly Automation[]
  readonly pending: readonly string[]
  readonly onOpen: (automationId: string) => void
  readonly store: AutomationStore
}

export function AutomationList({ automations, pending, onOpen, store }: AutomationListProps) {
  const [deleting, setDeleting] = useState<Automation | null>(null)
  if (automations.length === 0) {
    return (
      <p className="py-10 text-center text-xs text-muted-foreground">
        还没有自动化。从下面的模板开始，或者新建一个。
      </p>
    )
  }
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] table-fixed border-collapse text-left text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b border-divider">
              <th className="w-[34%] py-2 font-medium">自动化</th>
              <th className="w-[12%] py-2 font-medium">计划</th>
              <th className="w-[22%] py-2 font-medium">日程</th>
              <th className="w-[16%] py-2 font-medium">最近运行</th>
              <th className="w-[16%] py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {automations.map((automation) => {
              const run = latestRun(automation)
              const active = activeRun(automation)
              const busy = pending.some(
                (key) => key.endsWith(`:${automation.id}`) || key === `cancel:${active?.id}`,
              )
              return (
                <tr className="border-b border-divider/60" key={automation.id}>
                  <td className="py-3 pr-4">
                    <button
                      className="block w-full truncate text-left font-medium hover:underline"
                      onClick={() => onOpen(automation.id)}
                      type="button"
                    >
                      {automation.title}
                    </button>
                    <p className="truncate text-muted-foreground">{automation.prompt}</p>
                    <p
                      className="truncate text-muted-foreground"
                      title={automation.workspaceRoot ?? ''}
                    >
                      {automation.workspaceRoot ?? '需要选择工作目录'}
                    </p>
                    {automation.issue ? (
                      <p className="mt-1 text-destructive">{automation.issue}</p>
                    ) : null}
                  </td>
                  <td className="text-muted-foreground">
                    {automation.schedule === null ? '仅手动' : automation.enabled ? '启用' : '停用'}
                  </td>
                  <td className="text-muted-foreground">
                    <p>{describeSchedule(automation.schedule)}</p>
                    <p>{automation.timeZone}</p>
                    {automation.nextRunAt ? (
                      <time
                        dateTime={automation.nextRunAt}
                        title={new Date(automation.nextRunAt).toLocaleString()}
                      >
                        下次 {describeMoment(automation.nextRunAt)}
                      </time>
                    ) : null}
                  </td>
                  <td className="text-muted-foreground">
                    {run === null
                      ? '未运行'
                      : [RUN_LABELS[run.outcome], describeMoment(run.startedAt)].join(' · ')}
                  </td>
                  <td className="text-right">
                    {active === null ? (
                      <Action
                        disabled={busy}
                        label="运行"
                        onClick={() => {
                          void store.runNow(automation.id)
                        }}
                      />
                    ) : (
                      <Action
                        disabled={busy || active.outcome === 'cancelling'}
                        label={active.outcome === 'cancelling' ? '停止待确认' : '停止'}
                        onClick={() => {
                          void store.cancel(active.id)
                        }}
                      />
                    )}
                    {automation.schedule === null ? null : (
                      <Action
                        disabled={busy}
                        label={automation.enabled ? '停用' : '启用'}
                        onClick={() => {
                          void store.setEnabled(
                            automation.id,
                            automation.revision,
                            !automation.enabled,
                          )
                        }}
                      />
                    )}
                    <Action
                      disabled={busy || active !== null}
                      label="删除"
                      onClick={() => setDeleting(automation)}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <ConfirmationDialog
        confirmLabel="删除"
        description="删除任务定义及保留的运行索引。已有对话内容不会删除。"
        destructive
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting !== null) {
            void store.remove(deleting.id).then((removed) => {
              if (removed) {
                setDeleting(null)
              }
            })
          }
        }}
        open={deleting !== null}
        title="删除这条自动化？"
      />
    </>
  )
}

function Action({
  label,
  disabled,
  onClick,
}: {
  readonly label: string
  readonly disabled: boolean
  readonly onClick: () => void
}) {
  return (
    <button
      className="ml-1 rounded px-1.5 py-1 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  )
}
