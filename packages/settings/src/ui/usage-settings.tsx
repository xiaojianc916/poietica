import type { ThreadsStore } from '@poietica/conversation'
import { SegmentedControl, type SegmentedOption } from '@poietica/design-system'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ModelCatalogStore } from '../model-catalog/store'
import { ActivityHeatmap } from './activity-heatmap'
import { labelModels } from './model-labels'
import { ModelTrend } from './model-trend'
import { SettingsGroup, SettingsPage } from './settings-primitives'
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

/*
 * 用量页。两个时间窗口各管各的：滑块只改概览与趋势图，热力图恒定看最近 26 周。
 * 热力图不跟滑块走 —— 按周成列的图缩到 7 天只剩一列。
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

/** 账还没到时的那一份。常量而不是每次现造：否则趋势图每一帧都要重算。 */
const NO_MODEL_DAYS: readonly UsageModelDay[] = []

interface UsageMetric {
  readonly label: string
  /* undefined 让渲染层用 data-unrecorded 区分占位符，避免沿用读数的粗体样式。 */
  readonly value: string | undefined
  /* 读数是一整条模型名时收一档字号：它与「23」不是同一类字。 */
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

export interface UsageSettingsProps {
  readonly threads: ThreadsStore
  readonly readTokenDays: ReadTokenDays
  readonly readModelDays: ReadModelDays
  readonly readMessageCount: ReadMessageCount
  /** 模型名的唯一产地：agent 自己的目录。账上记的是 provider/id，屏幕上要写名字。 */
  readonly modelCatalog: ModelCatalogStore
}

/*
 * 读一次原生。
 *
 * 换窗口时**保留上一份**，等新的到了再换：先清空再铺回来会让整张图塌掉重画，
 * 屏幕上就是抖一下。正本 zcode 的 useUsageStats 也是这个读法（同 scope 保留旧
 * snapshot，换来源才清）。首帧没有上一份，那才如实空着。
 *
 * 读失败不写出数：宁可「没记过」，不写编出来的 0。
 */
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

export function UsageSettings({
  modelCatalog,
  readMessageCount,
  readModelDays,
  readTokenDays,
  threads,
}: UsageSettingsProps) {
  const catalog = useSyncExternalStore(modelCatalog.subscribe, modelCatalog.getSnapshot)

  useEffect(() => {
    void modelCatalog.load().catch(() => undefined)
  }, [modelCatalog])

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

  /*
   * 热力图那本账一次读满、终生不换：它的依赖里没有滑块，所以动滑块不会重读它。
   * 这正是「切范围不该让热力图抖一下」的那条 —— 它根本不需要那份数据。
   */
  const readLedger = useCallback(async () => {
    const found = await readTokenDays(LEDGER_DAYS)

    return new Map(found.map((day) => [day.day, day.tokens]))
  }, [readTokenDays])

  const ledger = useRead(readLedger)

  /* 两端补齐到整周：列是整周，半截开头或结尾会让首尾各缺一块。 */
  const heatmap = useMemo(
    () => spreadWeeks(ledger ?? new Map(), new Date(), HEATMAP_WEEKS),
    [ledger],
  )

  /* 概览那一格与热力图读的是同一本账，只是窗口短一些 —— 不另开一条口径。 */
  const tokens = useMemo(() => {
    if (ledger === undefined) {
      return undefined
    }

    return spread(ledger, new Date(), Number(span)).reduce((sum, day) => sum + day.count, 0)
  }, [ledger, span])

  /* 趋势图与概览那一格同一个窗口：滑块动，两条线跟着动。 */
  const window = Number(span)

  const readModels = useCallback(() => readModelDays(window), [readModelDays, window])

  const modelDays = useRead(readModels)

  const series = useMemo(
    () => labelModels(modelSeries(modelDays ?? NO_MODEL_DAYS, new Date(), window), catalog.data),
    [catalog.data, modelDays, window],
  )

  const readMessages = useCallback(() => readMessageCount(window), [readMessageCount, window])

  const messages = useRead(readMessages)

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
