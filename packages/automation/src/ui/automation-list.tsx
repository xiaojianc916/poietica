import {
  type Automation,
  type AutomationStore,
  describeMoment,
  describeSchedule,
  latestRun,
} from '@poietica/automation'
import { ConfirmationDialog } from '@poietica/design-system'
import { useState } from 'react'

/**
 * 「我的自动化」这张表。
 *
 * 自己不持有任何状态：它是快照的一次投影，加几个直接打到 store 上的动作。
 * 收整个 store 而不是三个回调，因为它确实要用到 runNow / setEnabled / remove
 * 三个命令；onOpen 单独收，因为那不是 store 的事 —— 那是这一格自己的导航。
 */

export interface AutomationListProps {
  readonly automations: readonly Automation[]
  readonly loaded: boolean
  readonly onOpen: (automationId: string) => void
  readonly store: AutomationStore
}

export function AutomationList({ automations, loaded, onOpen, store }: AutomationListProps) {
  /*
   * 待确认删除的那一条。删除不可撤销（定义与运行记录一起没），最后一道门
   * 是人说「确认」，不是行内那颗按钮直接落锤。对话框用全仓现成的那个
   * （@poietica/design-system 的 ConfirmationDialog），不为这里另搓一个。
   */
  const [pendingDelete, setPendingDelete] = useState<Automation | null>(null)

  /*
   * loaded 一起判：首帧和「读完了但确实一条都没有」不是同一件事，
   * 少了它空态会在启动瞬间闪一下。
   */
  if (loaded && automations.length === 0) {
    return (
      <p className="py-10 text-center text-xs text-muted-foreground">
        还没有自动化。从下面的模板开始，或者新建一个。
      </p>
    )
  }

  return (
    <>
      <table className="w-full table-fixed border-collapse text-left text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b border-divider">
            <th className="w-[38%] py-2 font-medium">自动化</th>
            <th className="w-[14%] py-2 font-medium">状态</th>
            <th className="w-[16%] py-2 font-medium">日程</th>
            <th className="w-[16%] py-2 font-medium">最近运行</th>
            <th className="w-[16%] py-2 text-right font-medium">操作</th>
          </tr>
        </thead>

        <tbody>
          {automations.map((automation) => (
            <Row
              automation={automation}
              key={automation.id}
              onAskDelete={setPendingDelete}
              onOpen={onOpen}
              store={store}
            />
          ))}
        </tbody>
      </table>

      <ConfirmationDialog
        confirmLabel="删除"
        description={
          pendingDelete === null
            ? ''
            : `「${pendingDelete.title}」与它的运行记录将一并删除，不可恢复。`
        }
        destructive
        onCancel={() => {
          setPendingDelete(null)
        }}
        onConfirm={() => {
          if (pendingDelete !== null) {
            store.remove(pendingDelete.id)
          }

          setPendingDelete(null)
        }}
        open={pendingDelete !== null}
        title="删除这条自动化？"
      />
    </>
  )
}

function Row({
  automation,
  onAskDelete,
  onOpen,
  store,
}: {
  readonly automation: Automation
  readonly onAskDelete: (automation: Automation) => void
  readonly onOpen: (automationId: string) => void
  readonly store: AutomationStore
}) {
  const run = latestRun(automation)

  return (
    <tr className="border-b border-divider/60">
      <td className="py-2.5 pr-4">
        {/* 标题就是入口。名字是这一行里唯一能代表整条记录的东西，
            所以点它进编辑器，而不是再挂一个「编辑」按钮。 */}
        <button
          className="block w-full truncate text-left font-medium hover:underline"
          onClick={() => {
            onOpen(automation.id)
          }}
          type="button"
        >
          {automation.title}
        </button>

        <p className="truncate text-muted-foreground">{automation.prompt}</p>
      </td>

      <td className="py-2.5 text-muted-foreground">{automation.enabled ? '启用' : '停用'}</td>

      {/* 表达式原文，等宽：这一列是给人核对配置的，不是一句措辞。 */}
      <td className="py-2.5 font-mono text-muted-foreground">
        {describeSchedule(automation.schedule)}
      </td>

      <td className="py-2.5 text-muted-foreground">
        {run === null
          ? '未运行'
          : `${run.outcome === 'succeeded' ? '成功' : '失败'} · ${describeMoment(run.startedAt)}`}
      </td>

      <td className="py-2.5 text-right">
        <RowAction
          label="运行"
          onClick={() => {
            store.runNow(automation.id)
          }}
        />
        <RowAction
          label={automation.enabled ? '停用' : '启用'}
          onClick={() => {
            store.setEnabled(automation.id, !automation.enabled)
          }}
        />
        <RowAction
          label="删除"
          onClick={() => {
            onAskDelete(automation)
          }}
        />
      </td>
    </tr>
  )
}

function RowAction({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return (
    <button
      className="ml-2 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  )
}
