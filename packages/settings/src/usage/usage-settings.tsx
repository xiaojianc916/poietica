import type { ThreadsStore } from '@poietica/agent'
import { Select, type SelectOption } from '@poietica/ui'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { SettingRow, SettingsGroup, SettingsPage } from '../surface/settings-primitives'
import { ActivityHeatmap } from './activity-heatmap'
import { type ActivitySummary, summarize } from './usage-activity'

/*
 * 用量页。
 *
 * 一页只有一个时间窗口。参考稿把「最近 7 天」的卡片与一张画了约半年的热力图放在
 * 同一屏，两个窗口都不标注 —— 人读到的「活跃天数」与格子讲的不是同一段时间。这里
 * 区间只声明一次，卡片、热力图、连续天数都读它。两档而不是三档：热力图按周成列，
 * 7 天只有一到两列，那不叫热力图。
 *
 * 数据只有一个来源：对话列表本身，含已归档的 —— 归档不等于没用过。列表记的是每条
 * 对话最后一次活动的时刻，所以这一页能诚实回答的只有「哪几天有过活动」。
 *
 * token、消息条数、模型分布本机一格都没记：对话记录里没有这些列，agent 也没有在
 * 协议里报过用量。那三格因此写「—」而不是 0 —— 0 的意思是「你没用过」，而事实是
 * 「没记过」。账本接上之后，这一页的版式不用改。
 */

const SPANS = [
  { value: '30', label: '最近 30 天' },
  { value: '182', label: '最近 26 周' },
] as const satisfies readonly SelectOption[]

type SpanValue = (typeof SPANS)[number]['value']

/** 还没有记账的那几格写它。 */
const UNRECORDED = '—'

interface UsageMetric {
  readonly label: string
  readonly value: string
  readonly hint: string
}

function metricsOf(summary: ActivitySummary): readonly UsageMetric[] {
  return [
    { label: '对话数', value: String(summary.threads), hint: '区间内有过活动的对话' },
    { label: '活跃天数', value: String(summary.activeDays), hint: '区间内有活动的天数' },
    { label: '连续天数', value: String(summary.streak), hint: '今天还没有活动时从昨天起算' },
    { label: 'Token 用量', value: UNRECORDED, hint: '本机还没有记账' },
    { label: '消息数量', value: UNRECORDED, hint: '本机还没有记账' },
    { label: '最常用模型', value: UNRECORDED, hint: '本机还没有记账' },
  ]
}

export interface UsageSettingsProps {
  readonly threads: ThreadsStore
}

export function UsageSettings({ threads }: UsageSettingsProps) {
  const active = useSyncExternalStore(threads.subscribe, threads.listSnapshot, threads.listSnapshot)

  const archived = useSyncExternalStore(
    threads.subscribe,
    threads.archivedSnapshot,
    threads.archivedSnapshot,
  )

  const [span, setSpan] = useState<SpanValue>('30')

  const summary = useMemo(
    () =>
      summarize(
        [...active.items, ...archived.items].map((item) => item.updatedAt),
        new Date(),
        Number(span),
      ),
    [active.items, archived.items, span],
  )

  const failure = active.failure ?? archived.failure

  return (
    <SettingsPage>
      {failure === null ? null : (
        <p className="settings-error" role="alert">
          {failure}
        </p>
      )}

      <SettingsGroup title="统计区间">
        <SettingRow description="卡片、热力图与连续天数都按这个区间统计。" label="时间范围">
          <Select
            className="settings-select-trigger"
            data={SPANS}
            onValueChange={setSpan}
            type="统计区间"
            value={span}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="概览">
        <div className="settings-metrics">
          {metricsOf(summary).map((metric) => (
            <article className="settings-metric" key={metric.label}>
              <p className="settings-metric__label">{metric.label}</p>

              <strong className="settings-metric__value">{metric.value}</strong>

              <p className="settings-metric__hint">{metric.hint}</p>
            </article>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="活跃热力图">
        <div className="settings-usage__panel">
          <p className="settings-usage__note">
            一格一天，一列一周。计的是那天有多少条对话最后有活动 —— 列表只留最后一次活动
            时刻，所以一条对话在很多天里活跃过，也只会点亮最后那一天。
          </p>

          <ActivityHeatmap busiest={summary.busiest} days={summary.days} />
        </div>
      </SettingsGroup>

      <SettingsGroup title="Token 与模型用量">
        <div className="settings-usage__panel">
          <p className="settings-usage__note">
            本机还没有 token 账本。对话记录里存的是标题、活动时刻与经过，没有一格 token 计数，agent
            也没有在协议里报过用量，所以上面那三格写「—」而不是 0。
          </p>
        </div>
      </SettingsGroup>
    </SettingsPage>
  )
}
