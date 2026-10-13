import { SegmentedControl, type SegmentedOption, SettingsGroup, SettingsPage } from '@poietica/design-system'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityHeatmap } from './activity-heatmap'
import { labelModels, type ModelNames } from './model-labels'
import { ModelTrend } from './model-trend'
import {
  formatTokens,
  modelSeries,
  type ReadMessageCount,
  type ReadModelDays,
  type ReadTokenDays,
  spread,
  spreadWeeks,
  summarize,
  type ThreadActivity,
  type UsageModelDay,
} from './usage-activity'

/* 结构与文案照 legacy 一字未改，换掉的只有数据来路。两个时间窗口各管各的：滑块只改概览与趋势图，热力图恒定看最近 26 周 —— 按周成列的图
 * 缩到 7 天只剩一列。 */

const SPANS = [
  { value: '7', label: '最近 7 天' },
  { value: '30', label: '最近 30 天' },
] as const satisfies readonly SegmentedOption[]

type SpanValue = (typeof SPANS)[number]['value']

const HEATMAP_WEEKS = 26

const LEDGER_DAYS = HEATMAP_WEEKS * 7

/** 0 的意思是「没用过」，而事实是「没记过」。 */
const UNRECORDED = '—'

const NO_MODEL_DAYS: readonly UsageModelDay[] = []

interface UsageMetric {
  readonly label: string
  readonly value: string | undefined
  readonly long?: boolean
}

function metricsOf(
  overview: ThreadActivity,
  tokens: number | undefined,
  messages: number | undefined,
  busiest: string | undefined,
): readonly UsageMetric[] {
  return [
    { label: 'Token 用量', value: tokens === undefined ? undefined : formatTokens(tokens) },
    { label: '对话数', value: String(overview.threads) },
    { label: '消息数量', value: messages === undefined ? undefined : String(messages) },
    { label: '活跃天数', value: String(overview.activeDays) },
    { label: '连续天数', value: String(overview.streak) },
    { label: '最常用模型', value: busiest, long: true },
  ]
}

/** 换窗口时**保留上一份**，等新的到了再换：先清空再铺回来会让整张图塌掉重画。读失败不写出数：宁可「没记过」，不写编出来的 0。 */
function useRead<T>(read: () => Promise<T>): T | undefined {
  const [value, setValue] = useState<T>()

  useEffect(() => {
    let active = true

    void read().then(
      (found) => {
        if (active) {
          setValue(found)
        }
      },
      () => undefined,
    )

    return () => {
      active = false
    }
  }, [read])

  return value
}

export interface UsageSettingsProps {
  readonly readTokenDays: ReadTokenDays
  readonly readModelDays: ReadModelDays
  readonly readMessageCount: ReadMessageCount
  readonly threadTimes: readonly string[]
  readonly modelNames: ModelNames
  readonly failure: string | null
}

export function UsageSettings({
  failure,
  modelNames,
  readMessageCount,
  readModelDays,
  readTokenDays,
  threadTimes,
}: UsageSettingsProps) {
  const [span, setSpan] = useState<SpanValue>('7')

  const overview = useMemo(() => summarize(threadTimes, new Date(), Number(span)), [threadTimes, span])

  /* 它的依赖里没有滑块，所以动滑块不会重读它 —— 这正是「切范围不该让热力图抖一下」的那条。 */
  const readLedger = useCallback(async () => {
    const found = await readTokenDays(LEDGER_DAYS)

    return new Map(found.map((day) => [day.day, day.tokens]))
  }, [readTokenDays])

  const ledger = useRead(readLedger)

  const heatmap = useMemo(() => spreadWeeks(ledger ?? new Map(), new Date(), HEATMAP_WEEKS), [ledger])

  const tokens = useMemo(() => {
    if (ledger === undefined) {
      return undefined
    }

    return spread(ledger, new Date(), Number(span)).reduce((sum, day) => sum + day.count, 0)
  }, [ledger, span])

  const window = Number(span)

  const readModels = useCallback(() => readModelDays(window), [readModelDays, window])

  const modelDays = useRead(readModels)

  const series = useMemo(
    () => labelModels(modelSeries(modelDays ?? NO_MODEL_DAYS, new Date(), window), modelNames),
    [modelDays, modelNames, window],
  )

  const readMessages = useCallback(() => readMessageCount(window), [readMessageCount, window])

  const messages = useRead(readMessages)

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
          {metricsOf(overview, tokens, messages, series[0]?.label).map((metric) => (
            <article className="settings-metric" key={metric.label}>
              <p className="settings-metric__label">{metric.label}</p>

              <strong
                className="settings-metric__value"
                data-long={metric.long === true ? 'true' : undefined}
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

      <SettingsGroup title="每日 Token 趋势图">
        <div className="settings-usage__panel">
          {series.length === 0 ? (
            <p className="settings-usage__empty">这一段还没有按模型的账。</p>
          ) : (
            <ModelTrend series={series} />
          )}
        </div>
      </SettingsGroup>
    </SettingsPage>
  )
}
