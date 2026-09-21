import type { ThreadsStore } from '@poietica/conversation'
import { SegmentedControl, type SegmentedOption } from '@poietica/design-system'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ActivityHeatmap } from './activity-heatmap'
import { SettingsGroup, SettingsPage } from './settings-primitives'
import {
  formatTokens,
  type ReadTokenDays,
  spread,
  summarize,
  type ThreadActivity,
} from './usage-activity'

/*
 * 用量页。两个时间窗口各管各的：滑块只改概览的数，热力图恒定看最近 26 周，
 * 窗口写进组标题。热力图不跟滑块走 —— 按周成列的图缩到 7 天只剩一列。
 */

const SPANS = [
  { value: '7', label: '最近 7 天' },
  { value: '30', label: '最近 30 天' },
] as const satisfies readonly SegmentedOption[]

type SpanValue = (typeof SPANS)[number]['value']

const HEATMAP_WEEKS = 26

/** 热力图那段日历，也是一次读回来的窗口：概览的两档都落在它里面。 */
const LEDGER_DAYS = HEATMAP_WEEKS * 7

/** 这一格还没有账可查时画它。0 的意思是「没用过」，而事实是「没记过」。 */
const UNRECORDED = '—'

interface UsageMetric {
  readonly label: string
  /* undefined 让渲染层用 data-unrecorded 区分占位符，避免沿用读数的粗体样式。 */
  readonly value: string | undefined
}

function metricsOf(overview: ThreadActivity, tokens: number | undefined): readonly UsageMetric[] {
  return [
    { label: 'Token 用量', value: tokens === undefined ? undefined : formatTokens(tokens) },
    { label: '对话数', value: String(overview.threads) },
    { label: '消息数量', value: undefined },
    { label: '活跃天数', value: String(overview.activeDays) },
    { label: '连续天数', value: String(overview.streak) },
    { label: '最常用模型', value: undefined },
  ]
}

export interface UsageSettingsProps {
  readonly threads: ThreadsStore
  readonly readTokenDays: ReadTokenDays
}

/*
 * 一次读满热力图窗口，切概览范围不再多跑原生。读失败不写出数：宁可「没记过」，
 * 不写编出来的 0。
 */
function useTokenLedger(readTokenDays: ReadTokenDays): ReadonlyMap<string, number> | undefined {
  const [ledger, setLedger] = useState<ReadonlyMap<string, number>>()

  useEffect(() => {
    let active = true

    void readTokenDays(LEDGER_DAYS).then(
      (days) => {
        if (active) {
          setLedger(new Map(days.map((day) => [day.day, day.tokens])))
        }
      },
      () => undefined,
    )

    return () => {
      active = false
    }
  }, [readTokenDays])

  return ledger
}

export function UsageSettings({ readTokenDays, threads }: UsageSettingsProps) {
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

  const ledger = useTokenLedger(readTokenDays)

  const heatmap = useMemo(() => spread(ledger ?? new Map(), new Date(), LEDGER_DAYS), [ledger])

  /* 概览那一格与热力图读的是同一本账，只是窗口短一些 —— 不另开一条口径。 */
  const tokens = useMemo(() => {
    if (ledger === undefined) {
      return undefined
    }

    return spread(ledger, new Date(), Number(span)).reduce((sum, day) => sum + day.count, 0)
  }, [ledger, span])

  const failure = active.failure ?? archived.failure

  return (
    <SettingsPage>
      {failure === null ? null : (
        <p className="settings-error" role="alert">
          {failure}
        </p>
      )}

      <SettingsGroup
        headerAction={
          <SegmentedControl
            label="概览的时间范围"
            name="usage-span"
            onValueChange={setSpan}
            options={SPANS}
            value={span}
          />
        }
        title="概览"
      >
        <div className="settings-metrics">
          {metricsOf(overview, tokens).map((metric) => (
            <article className="settings-metric" key={metric.label}>
              <p className="settings-metric__label">{metric.label}</p>

              <strong
                className="settings-metric__value"
                data-unrecorded={metric.value === undefined ? 'true' : undefined}
              >
                {metric.value ?? UNRECORDED}
              </strong>
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
