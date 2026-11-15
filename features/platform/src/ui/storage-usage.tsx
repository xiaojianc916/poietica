import { Button, formatBytes } from '@poietica/design-system'
import { RefreshCw } from 'lucide-react'
import type { CSSProperties, ReactElement } from 'react'
import type { StorageEntry, StorageEntryId, StorageUsage } from '../contract'

/*
 * 磁盘用量：一枚按大小拼起来的短棒总线 + 一张逐格对账的账单。
 *
 * 条只画形状 —— 长短告诉你谁大；精确的账在下面每一行里：色签、类目、点线引导、右对齐的读数、
 * 右对齐的占比。六档色借趋势图那套序列色（同是「多个平级类别」，谈不上对错），不借语义色那四档：
 * 用量图里没有「出错了」。
 *
 * 账上只出现真的占了地方的格子：0 字节的那几格既不占条，也不占一行 —— 一行「0 字节」除了多占一
 * 行之外没有信息，反而把真正的读数推下去。契约里九格中常有几格为 0（内置工具、没打开过的浏览器分区）。
 */

const MB = 1024 * 1024
/* 低于一档的读数写字节：一排「0.1 MB」不如「128 字节」直观。 */
const TINY = 0.1 * MB
/* 占比那列只到 0.1%：再小的一律写「<0.1%」，不四舍五入成 0.0%。 */
const SHARE_FLOOR = 0.1
/* 短棒从左到右接力弹出的节拍：一格比上一格晚 90ms（与方向 A 的稿同一档）。 */
const DRAW_STEP_MS = 90

/*
 * 一格一色，**按契约 id 定档**，不按屏幕顺序轮转：账单是从大到小排的，某一格这次大、下次小，
 * 颜色必须还是它 —— 否则同一个数字换一行就换一种颜色，人对不上。
 * -1 是「不上条的那一档」：契约把「内置工具」单独列了一格，它多数时候是 0，用分隔线那档灰。
 */
const SERIES_BY_ID: Readonly<Record<StorageEntryId, number>> = {
  conversations: 0,
  database: 1,
  'omp-other': 1,
  attachments: 2,
  'browser-data': 3,
  'kernel-state': 3,
  logs: 4,
  'kernel-cache': 5,
  tools: -1,
}

export interface StorageSegment {
  readonly label: string
  /* 序列色档 0..5；-1 是「内置工具」，落在分隔线那档墨上。 */
  readonly series: number
  readonly bytes: number
  readonly caption: string
  /* 条上占比（%），各段之和 100；短棒的 flex-grow 就用它。几百字节的格子被抬到 0.2%，只影响条的形状。 */
  readonly share: number
  /* 账上的真占比（%）：不抬、不归一，就是这一格占实测总量的比例。 */
  readonly shareCaption: string
}

/**
 * 契约把存储切得很细：同名的几格在屏幕上合成一格（如「Agent 数据」= 数据库 + agent 数据）。
 * 两格并一格之后名字由宿主的 STORAGE_LABELS 给，界面上不再有「临时会话文件夹」这种只有几 MB 的独立类。
 * 合成之后第一格的 id 就是这一类的色档来源。
 */
function mergeByName(entries: readonly StorageEntry[]): { id: StorageEntryId; label: string; bytes: number }[] {
  const merged: { id: StorageEntryId; label: string; bytes: number }[] = []
  for (const entry of entries) {
    const seen = merged.find((item) => item.label === entry.label)
    if (seen === undefined) merged.push({ id: entry.id, label: entry.label, bytes: entry.bytes })
    else seen.bytes += entry.bytes
  }
  return merged
}

/**
 * 账上的格子：合并同名、只留真占了地方的、从大到小读。等量时保持契约顺序（sort 是稳定的）。
 * 返回空数组的意思是「这一台机器上什么都没占」—— 调用方不再画条。
 */
export function storageSegments(entries: readonly StorageEntry[], total: number): StorageSegment[] {
  const list = mergeByName(entries).filter((item) => item.bytes > 0)
  const sum = list.reduce((acc, item) => acc + item.bytes, 0)
  /* 各格按读数里的占比摊到实测总量上：实测比读数多出来的字节（扫描没走到的）按大小分摊。 */
  const sizes = list.map((item) => (sum > 0 ? (item.bytes / sum) * total : 0))
  /* 一段至少留 0.2%：几百字节的那几格按比例在几百像素的条上会被压没，人眼只看到一道缝。 */
  const widths = sizes.map((size) => (total > 0 ? Math.max(0.2, (size / total) * 100) : 0))
  const scale = widths.reduce((acc, width) => acc + width, 0)

  const segments = list.map((item, index) => {
    const share = scale > 0 ? ((widths[index] ?? 0) / scale) * 100 : 0
    /* 账上的占比按实测总量算，不按上面那条被抬过的条算：条只报形状，账要报真数。 */
    const percent = total > 0 ? ((sizes[index] ?? 0) / total) * 100 : 0

    return {
      label: item.label,
      series: SERIES_BY_ID[item.id],
      bytes: item.bytes,
      caption: item.bytes >= TINY ? formatBytes(item.bytes) : `${item.bytes} 字节`,
      share,
      shareCaption: percent >= SHARE_FLOOR ? `${percent.toFixed(1)}%` : '<0.1%',
    }
  })

  return segments.sort((a, b) => b.bytes - a.bytes)
}

/**
 * 占用那张卡：总量一枚读数、一枚测量按钮，一条短棒总线，下面一格一行的账。
 *
 * 提出来是为了让真机快照（features/platform/scripts/harness.tsx）截到的就是页面上这同一份组件，
 * 不是照着抄一遍的仿制品 —— 仿制品会在改动之后继续绿着，而屏幕上早就不是那样了。
 */
export function StorageOverview({
  busy,
  onRemeasure,
  usage,
  warning,
}: {
  readonly busy: boolean
  readonly onRemeasure: () => void
  readonly usage: StorageUsage | null
  readonly warning?: string | undefined
}): ReactElement {
  const amount = usage === null ? { value: '正在测量…', unit: '' } : splitUnit(formatBytes(totalOf(usage.entries)))

  return (
    <div className="settings-storage__stack">
      <div className="settings-storage__head">
        <div>
          {/* 总量是这一屏唯一的主角：一枚读数加一行「什么时候量的」，按钮退到右边。 */}
          <p className="settings-storage__total">
            {amount.value}
            {amount.unit === '' ? null : <span className="settings-storage__unit">{amount.unit}</span>}
          </p>
          <p className="settings-storage__meta">
            {usage === null
              ? '读一遍数据根，很快就回来'
              : `总占用 · 上次测量 ${measuredLabel(usage.measuredAt ?? null, Date.now())}`}
          </p>
        </div>

        {/* 幽灵底 + 一道卡片线：测量是这张卡里的次要动作，不该与卡面同重。 */}
        <Button
          className="gap-1.5 border border-divider"
          disabled={busy}
          onClick={onRemeasure}
          size="xs"
          type="button"
          variant="ghost"
        >
          <RefreshCw aria-hidden="true" className={busy ? 'animate-spin' : undefined} />
          <span>{busy ? '测量中…' : '重新测量'}</span>
        </Button>
      </div>

      {warning === undefined ? null : (
        <p className="settings-row__warning" role="alert">
          {warning}
        </p>
      )}

      {usage === null ? null : <StorageBar usage={usage} />}
    </div>
  )
}

/** 有账才画：从没量过的空白由 StorageOverview 那一行「正在测量…」承担，这里不重复。 */
export function StorageBar({ usage }: { readonly usage: StorageUsage }): ReactElement {
  const segments = storageSegments(usage.entries, totalOf(usage.entries))

  /* 一台机器上什么都没占时不留一条空轨道。 */
  if (segments.length === 0) return <p className="settings-storage__blank">还没有占用的数据。</p>

  return (
    <div className="settings-storage">
      {/*
       * 条只画形状：读数在下面每一行里。
       * key 挂在测量时刻上：每量一次就重挂一次，短棒于是从左到右重新「画」一遍（动画只在挂载时跑）。
       */}
      <div aria-hidden="true" className="settings-storage__ruler" key={usage.measuredAt ?? 0}>
        {segments.map((segment, rank) => (
          <span
            className="settings-storage__segment"
            data-series={segment.series}
            key={segment.label}
            style={
              {
                flexGrow: segment.share,
                '--settings-storage-rank': String(rank),
                '--settings-storage-step': `${String(DRAW_STEP_MS)}ms`,
              } as CSSProperties
            }
          />
        ))}
      </div>

      <dl className="settings-storage__ledger">
        {segments.map((segment) => (
          <div className="settings-storage__row" key={segment.label}>
            <dt>
              <span aria-hidden="true" className="settings-storage__tick" data-series={segment.series} />
              {segment.label}
            </dt>
            <dd className="settings-storage__value">{segment.caption}</dd>
            <dd className="settings-storage__share">{segment.shareCaption}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** formatBytes 的两种写法都带单位（「238 MB」「512 B」），在这里只切开摆放，不重排数字。 */
function splitUnit(text: string): { value: string; unit: string } {
  const at = text.lastIndexOf(' ')
  return at === -1 ? { value: text, unit: '' } : { value: text.slice(0, at), unit: text.slice(at + 1) }
}

function totalOf(entries: readonly StorageEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.bytes, 0)
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * 「上次测量」写成人话：今天 / 昨天带时刻，更早的写月日带时刻 —— 精确到分钟就够，秒没有信息量。
 * 昨天按日历日减一天算，不用 24 小时：跨零点时「24 小时前」会把昨天读成今天。
 */
export function measuredLabel(at: number | null, now: number): string {
  if (at === null) return '还没有量过'

  const stamp = new Date(at)
  const time = `${pad2(stamp.getHours())}:${pad2(stamp.getMinutes())}`
  if (sameDay(stamp, new Date(now))) return `今天 ${time}`

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (sameDay(stamp, yesterday)) return `昨天 ${time}`

  return `${stamp.getMonth() + 1} 月 ${stamp.getDate()} 日 ${time}`
}
