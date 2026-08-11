import type { ThreadsStore } from '@poietica/agent'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { SegmentedControl, type SegmentedOption } from '../surface/segmented-control'
import { SettingRow, SettingsGroup, SettingsPage } from '../surface/settings-primitives'
import { ActivityHeatmap } from './activity-heatmap'
import { spread, summarize, type ThreadActivity } from './usage-activity'

/*
 * 用量页。
 *
 * 页上有两个时间窗口，各管各的：滑块只改概览那几个数；热力图恒定看最近 26 周。
 * 两个窗口同屏必须能被分辨，所以那张图的窗口写进它自己的组标题，而不是靠人猜。
 * 热力图不跟着滑块走 —— 一张按周成列的图缩到 7 天只剩一列，那不是热力图。
 */

const SPANS = [
  { value: '7', label: '最近 7 天' },
  { value: '30', label: '最近 30 天' },
] as const satisfies readonly SegmentedOption[]

type SpanValue = (typeof SPANS)[number]['value']

const HEATMAP_WEEKS = 26

/** 还没有记账的那几格写它。0 的意思是「没用过」，而事实是「没记过」。 */
const UNRECORDED = '—'

/*
 * 每天的 token 账。
 *
 * 本机还没有这本账：对话记录里没有 token 列，agent 也没有在协议里报过用量。所以
 * 这里是一本空账 —— 热力图照常铺出 26 周的日历，只是每一格都是最低档。账本接上
 * 之后把这里换成真的 Map，键是 YYYY-MM-DD 的本地日历日，值是那天的 token 总数，
 * 这一页其余部分一个字都不用改。
 */
const TOKEN_LEDGER: ReadonlyMap<string, number> = new Map()

interface UsageMetric {
  readonly label: string
  readonly value: string
}

function metricsOf(overview: ThreadActivity): readonly UsageMetric[] {
  return [
    { label: 'Token 用量', value: UNRECORDED },
    { label: '对话数', value: String(overview.threads) },
    { label: '消息数量', value: UNRECORDED },
    { label: '活跃天数', value: String(overview.activeDays) },
    { label: '连续天数', value: String(overview.streak) },
    { label: '最常用模型', value: UNRECORDED },
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

  const [span, setSpan] = useState<SpanValue>('7')

  const overview = useMemo(
    () =>
      summarize(
        [...active.items, ...archived.items].map((item) => item.updatedAt),
        new Date(),
        Number(span),
      ),
    [active.items, archived.items, span],
  )

  const heatmap = useMemo(() => spread(TOKEN_LEDGER, new Date(), HEATMAP_WEEKS * 7), [])

  const failure = active.failure ?? archived.failure

  return (
    <SettingsPage>
      {failure === null ? null : (
        <p className="settings-error" role="alert">
          {failure}
        </p>
      )}

      <SettingsGroup title="概览">
        <SettingRow label="时间范围">
          <SegmentedControl
            label="概览的时间范围"
            name="usage-span"
            onValueChange={setSpan}
            options={SPANS}
            value={span}
          />
        </SettingRow>

        <div className="settings-metrics">
          {metricsOf(overview).map((metric) => (
            <article className="settings-metric" key={metric.label}>
              <p className="settings-metric__label">{metric.label}</p>

              <strong className="settings-metric__value">{metric.value}</strong>
            </article>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Token 热力图 · 最近 26 周">
        <div className="settings-usage__panel">
          <ActivityHeatmap days={heatmap} />
        </div>
      </SettingsGroup>
    </SettingsPage>
  )
}
