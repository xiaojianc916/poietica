import type { ThreadsStore } from '@poietica/conversation'
import { readTokenDays } from '@poietica/native-bridge'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
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

/** 热力图那段日历，也是一次读回来的窗口：概览的两档都落在它里面。 */
const LEDGER_DAYS = HEATMAP_WEEKS * 7

/** 这一格还没有账可查时写它。0 的意思是「没用过」，而事实是「没记过」。 */
const UNRECORDED = '—'

/** 大数要分组，而分组规则是平台的事。 */
const TOKENS = new Intl.NumberFormat()

interface UsageMetric {
  readonly label: string
  readonly value: string
}

function metricsOf(overview: ThreadActivity, tokens: number | undefined): readonly UsageMetric[] {
  return [
    { label: 'Token 用量', value: tokens === undefined ? UNRECORDED : TOKENS.format(tokens) },
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

/*
 * 账本这一侧的读：一次读满热力图那段日历，切时间范围因此不再往原生侧多跑一趟。
 *
 * 读不出来就不写出一个数（与「关于」页问版本号同一条规矩）：这一格宁可说
 * 「没记过」，也不写一个编出来的 0。
 */
function useTokenLedger(): ReadonlyMap<string, number> | undefined {
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
  }, [])

  return ledger
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

  const ledger = useTokenLedger()

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
          {metricsOf(overview, tokens).map((metric) => (
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
