import type { ToolCallRendererProps } from '@poietica/feature-conversation/ui-api'
import { type NavigationService, NavigationToken, useService } from '@poietica/ui-kernel'
import { AlarmClock } from 'lucide-react'
import type { ReactNode } from 'react'
import { describeSchedule } from './automation'
import './automation-tool-card.css'

/*
 * agent 那条线的定时任务工具卡片（07 页 §9E 的 `toolCallRenderers`：`/^automation_/`）。
 *
 * 字段来源：工具结果以 JSON 文本返给模型（07 页 §9D 的 agent 工具表），args 是模型
 * 传进来的参数 —— 新建时标题与计划在 args 里，列表/更新/删除时任务在 result 里。
 * 两个来源都读一遍：卡片画的就是「这一次调用说了哪条任务」。卡片上没有新的动作，
 * 唯一的按钮是「打开」——它把编辑表面拉到眼前，与运行记录点开对话是同一条路。
 */

const ACTION_LABELS: Readonly<Record<string, string>> = {
  automation_create: '创建定时任务',
  automation_delete: '删除定时任务',
  automation_list: '列出定时任务',
  automation_update: '修改定时任务',
}

function bag(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function textOf(value: unknown, key: string): string | null {
  const raw = bag(value)[key]
  return typeof raw === 'string' && raw !== '' ? raw : null
}

/** 工具结果是一段 JSON 文本：解析得出来才当记录读，读不出来就只画动作名。 */
function recordOf(result: unknown): Record<string, unknown> {
  const text = textOf(result, 'text')
  if (text === null) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return bag(Array.isArray(parsed) ? parsed[0] : parsed)
  } catch {
    return {}
  }
}

function cronOf(value: unknown): string | null {
  const schedule = bag(value).schedule
  if (typeof schedule === 'string') {
    return schedule
  }
  return textOf(schedule, 'cron')
}

export function AutomationToolCard({ args, result, status, toolName }: ToolCallRendererProps): ReactNode {
  const navigation = useService(NavigationToken) as NavigationService
  const record = recordOf(result)
  const automationId = textOf(record, 'id') ?? textOf(args, 'id')
  const title = textOf(record, 'title') ?? textOf(args, 'title')
  const cron = cronOf(record) ?? cronOf(args)
  const action = ACTION_LABELS[toolName] ?? toolName
  const line = title === null ? action : `${action}：${title}`

  return (
    <section className="timeline-tool automation-tool" data-automation-tool="">
      <div className="timeline-row">
        <AlarmClock aria-hidden className="timeline-row__icon" />
        <span className="timeline-row__label">{line}</span>
        {cron === null ? null : <span className="automation-tool__status">{describeSchedule(cron)}</span>}
        {status === 'running' ? <span className="automation-tool__status">进行中</span> : null}
        {status === 'failed' ? (
          <span className="automation-tool__status automation-tool__status--failed">失败</span>
        ) : null}
      </div>

      {automationId === null ? null : (
        <div className="automation-tool__actions">
          <button
            className="automation-tool__open"
            onClick={() => {
              navigation.navigate({ surface: 'automations.edit', params: { automationId } })
            }}
            type="button"
          >
            打开
          </button>
        </div>
      )}
    </section>
  )
}
