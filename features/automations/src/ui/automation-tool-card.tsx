import type { ToolCallRendererProps } from '@poietica/feature-conversation/ui-api'
import {
  AlarmClock,
  ArrowUpRight,
  CircleCheck,
  CirclePause,
  CircleSlash,
  CircleX,
  LoaderCircle,
  Play,
  SkipForward,
  TriangleAlert,
} from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { describeMoment } from './automation'
import {
  type CardAutomation,
  type CardBody,
  type CardListRow,
  type CardRunRow,
  clockText,
  type RunGlyph,
  type ToolCardModel,
  toolCardOf,
} from './tool-card-model'
import './automation-tool-card.css'

/*
 * 对话里「定时任务」工具卡（审查 R-16；07 页 §9E 的 `toolCallRenderers`：`/^automation_/`）。
 *
 * 视觉语言全部借时间线：折叠行是 .timeline-row（图标 + 一句话），摊开的那张纸是
 * .timeline-tool__body（--cp-timeline-drawer-surface、--cp-radius-item、缩进到第一个字）。
 * 这里只加时间线没有的几样：任务的标题与状态、计划那一句、元信息网格、接下来几次、
 * 两枚动作。不用阴影、不用渐变、不用品牌色 —— 颜色只出现在状态点与「需要你关注」上。
 *
 * 「这一次调用说了什么」由 tool-card-model.ts 的 toolCardOf 判（纯函数、有测试），
 * 本文件只画。卡片里的动作走 deps（打开编辑页 / 立即运行 / 打开对话），由 index.tsx 装配。
 */

export interface ToolCardDeps {
  /** 这条任务现在还在不在（删掉了就不画动作） */
  readonly useExists: (automationId: string) => boolean
  readonly openAutomation: (automationId: string) => void
  readonly runNow: (automationId: string) => void
  readonly openThread: (threadId: string) => void
  readonly now?: () => number
}

const RUN_GLYPH: Readonly<
  Record<RunGlyph, { readonly Icon: ComponentType<{ className?: string }>; readonly label: string }>
> = {
  succeeded: { Icon: CircleCheck, label: '成功' },
  failed: { Icon: CircleX, label: '失败' },
  running: { Icon: LoaderCircle, label: '运行中' },
  awaiting: { Icon: CirclePause, label: '等待批准' },
  cancelled: { Icon: CircleSlash, label: '已取消' },
  skipped: { Icon: SkipForward, label: '已跳过' },
}

function StatusChip({ model }: { readonly model: ToolCardModel }): ReactNode {
  if (model.status === 'running') return <span className="automation-tool__chip">进行中</span>
  if (model.status === 'failed') {
    return (
      <span className="automation-tool__chip" data-tone="danger">
        失败
      </span>
    )
  }
  return model.hint === null ? null : <span className="automation-tool__hint">{model.hint}</span>
}

function NextLine({ automation, now }: { readonly automation: CardAutomation; readonly now: number }): ReactNode {
  const next = automation.nextRunAt
  const when = next === null ? null : clockText(next, automation.timeZone)
  return (
    <p className="automation-tool__plan">
      <span>{automation.plan}</span>
      {next === null || when === null ? null : automation.once ? (
        <span className="automation-tool__quiet">（{describeMoment(next, now)}）</span>
      ) : (
        <>
          <span aria-hidden className="automation-tool__sep">
            ·
          </span>
          <span>
            下次 <time dateTime={new Date(next).toISOString()}>{when}</time>
            <span className="automation-tool__quiet">（{describeMoment(next, now)}）</span>
          </span>
        </>
      )}
    </p>
  )
}

function AutomationBody({
  automation,
  changed,
  deps,
  now,
}: {
  readonly automation: CardAutomation
  readonly changed: readonly string[]
  readonly deps: ToolCardDeps
  readonly now: number
}): ReactNode {
  const exists = deps.useExists(automation.id)
  return (
    <div className="timeline-tool__body automation-tool__card">
      <div className="automation-tool__head">
        <span className="automation-tool__title">{automation.title}</span>
        <span className="automation-tool__state" data-tone={exists ? automation.state.tone : 'quiet'}>
          <span aria-hidden className="automation-tool__dot" />
          {exists ? automation.state.label : '已删除'}
        </span>
      </div>
      <NextLine automation={automation} now={now} />
      {changed.length === 0 ? null : <p className="automation-tool__changed">已修改：{changed.join('、')}</p>}
      {automation.prompt === '' ? null : <p className="automation-tool__prompt">{automation.prompt}</p>}
      {automation.issue === null ? null : (
        <p className="automation-tool__issue">
          <TriangleAlert aria-hidden className="automation-tool__glyph" />
          {automation.issue}
        </p>
      )}
      <dl className="automation-tool__meta">
        {automation.meta.map((row) => (
          <div className="automation-tool__meta-row" key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <div className="automation-tool__foot">
        {automation.upcoming.length === 0 ? (
          <span />
        ) : (
          <span className="automation-tool__upcoming">接下来 {automation.upcoming.join(' · ')}</span>
        )}
        {exists ? (
          <span className="automation-tool__actions">
            <button className="automation-tool__button" onClick={() => deps.runNow(automation.id)} type="button">
              <Play aria-hidden className="automation-tool__glyph" />
              立即运行
            </button>
            <button
              className="automation-tool__button"
              onClick={() => deps.openAutomation(automation.id)}
              type="button"
            >
              打开任务
              <ArrowUpRight aria-hidden className="automation-tool__glyph" />
            </button>
          </span>
        ) : null}
      </div>
    </div>
  )
}

function ListBody({
  deps,
  more,
  rows,
}: {
  readonly deps: ToolCardDeps
  readonly more: number
  readonly rows: readonly CardListRow[]
}): ReactNode {
  if (rows.length === 0) {
    return <p className="automation-tool__empty">还没有定时任务</p>
  }
  return (
    <ul className="timeline-tool__body automation-tool__list">
      {rows.map((row) => (
        <li key={row.id}>
          <button className="automation-tool__item" onClick={() => deps.openAutomation(row.id)} type="button">
            <span aria-hidden className="automation-tool__dot" data-tone={row.tone} />
            <span className="automation-tool__item-title">{row.title}</span>
            <span className="automation-tool__item-plan">{row.plan}</span>
            {row.last === null ? null : (
              <span className="automation-tool__item-last" data-tone={row.lastTone}>
                {row.last}
              </span>
            )}
          </button>
        </li>
      ))}
      {more === 0 ? null : <li className="automation-tool__more">还有 {more} 个</li>}
    </ul>
  )
}

function RunRow({ deps, row }: { readonly deps: ToolCardDeps; readonly row: CardRunRow }): ReactNode {
  const { Icon, label } = RUN_GLYPH[row.glyph]
  const content = (
    <>
      <span className="automation-tool__run-glyph" data-glyph={row.glyph} title={label}>
        <Icon aria-hidden className="automation-tool__glyph" />
        <span className="sr-only">{label}</span>
      </span>
      <time className="automation-tool__run-when">{row.when}</time>
      {row.tag === null ? null : <span className="automation-tool__tag">{row.tag}</span>}
      <span className="automation-tool__run-text">{row.text ?? label}</span>
    </>
  )
  const threadId = row.threadId
  return (
    <li>
      {threadId === null ? (
        <span className="automation-tool__item" data-static="">
          {content}
        </span>
      ) : (
        <button className="automation-tool__item" onClick={() => deps.openThread(threadId)} type="button">
          {content}
        </button>
      )}
    </li>
  )
}

function Body({ body, deps, now }: { readonly body: CardBody; readonly deps: ToolCardDeps; readonly now: number }) {
  switch (body.kind) {
    case 'automation':
      return <AutomationBody automation={body.automation} changed={body.changed} deps={deps} now={now} />
    case 'list':
      return <ListBody deps={deps} more={body.more} rows={body.rows} />
    case 'runs':
      return body.rows.length === 0 ? (
        <p className="automation-tool__empty">还没有运行记录</p>
      ) : (
        <ul className="timeline-tool__body automation-tool__list">
          {body.rows.map((row) => (
            <RunRow deps={deps} key={row.id} row={row} />
          ))}
        </ul>
      )
    case 'report':
      return (
        <div className="timeline-tool__body automation-tool__report" data-attention={body.attention ? '' : undefined}>
          {body.attention ? (
            <span className="automation-tool__flag">
              <TriangleAlert aria-hidden className="automation-tool__glyph" />
              需要你关注
            </span>
          ) : null}
          <p className="automation-tool__summary">{body.summary}</p>
        </div>
      )
    case 'run': {
      const threadId = body.threadId
      return threadId === null ? null : (
        <div className="automation-tool__inline-actions">
          <button className="automation-tool__button" onClick={() => deps.openThread(threadId)} type="button">
            查看这次运行
            <ArrowUpRight aria-hidden className="automation-tool__glyph" />
          </button>
        </div>
      )
    }
    default:
      return null
  }
}

/** 纯展示：模型 + 动作。预览页（静态渲染）与真卡片共用这一份。 */
export function AutomationToolCardView({
  deps,
  model,
}: {
  readonly deps: ToolCardDeps
  readonly model: ToolCardModel
}): ReactNode {
  const now = deps.now?.() ?? Date.now()
  return (
    <section className="timeline-tool automation-tool" data-automation-tool="" data-status={model.status}>
      <div className="timeline-row automation-tool__row">
        {model.status === 'running' ? (
          <LoaderCircle aria-hidden className="timeline-row__icon automation-tool__spin" />
        ) : (
          <AlarmClock aria-hidden className="timeline-row__icon" />
        )}
        <span className="timeline-row__label">{model.line}</span>
        <StatusChip model={model} />
      </div>
      {model.error === null ? null : <p className="automation-tool__error">{model.error}</p>}
      <Body body={model.body} deps={deps} now={now} />
    </section>
  )
}

/** 装配：index.tsx 把 store 与导航交进来，得到 conversation 要的那枚组件。 */
export function createAutomationToolCard(deps: ToolCardDeps): ComponentType<ToolCallRendererProps> {
  return function AutomationToolCard({ args, result, status, toolName }: ToolCallRendererProps): ReactNode {
    return <AutomationToolCardView deps={deps} model={toolCardOf(toolName, args, result, status)} />
  }
}
