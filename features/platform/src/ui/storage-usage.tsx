import { formatBytes } from '@poietica/design-system'
import type { ReactElement } from 'react'
import type { StorageEntry } from '../contract'

/*
 * 磁盘用量条：一条按大小铺满的堆叠条 + 一格一类的图例（一格是「标签一行、读数下一行」）。
 *
 * 六档色借趋势图那套序列色（同是「多个平级类别」，谈不上对错），不借语义色那四档。
 * 占用为 0 的格子不上条，但留在图例里 —— 图一里那几格就写着「0 字节」。
 */

const SERIES_INKS = 6
const MB = 1024 * 1024
/* 低于一档的读数写字节：图例里一排「0.1 MB」不如「128 字节」直观。 */
const TINY = 0.1 * MB
const OTHER_LABEL = '其它'

export interface StorageSegment {
  readonly label: string
  /* 序列色档 0..5；-1 是「其它」，落在条的底色上。 */
  readonly series: number
  readonly bytes: number
  readonly caption: string
  /* 条上占比（%），各段之和 100。 */
  readonly share: number
}

/**
 * 契约把存储切得很细：同名的几格在屏幕上合成一格（如「Agent 数据」= 数据库 + agent 数据 + 临时会话目录）。
 * 三格并一格之后名字由宿主的 STORAGE_LABELS 给，界面上不再有「临时会话文件夹」这种只有几 MB 的独立类。
 */
function mergeByName(entries: readonly StorageEntry[]): { label: string; bytes: number }[] {
  const merged: { label: string; bytes: number }[] = []
  for (const entry of entries) {
    const seen = merged.find((item) => item.label === entry.label)
    if (seen === undefined) merged.push({ label: entry.label, bytes: entry.bytes })
    else seen.bytes += entry.bytes
  }
  return merged
}

/**
 * 排在末尾的「其它」= 数据根里没归类的文件；浏览器那两格各占一类，不进这一格。
 * 它只在界面上有，契约里没有对应 id。
 */
export function storageSegments(entries: readonly StorageEntry[], total: number): StorageSegment[] {
  const list = [...mergeByName(entries), { label: OTHER_LABEL, bytes: 0 }]
  const sum = list.reduce((acc, item) => acc + item.bytes, 0)
  const live = list.filter((item) => item.bytes > 0).length
  /* 各格按读数里的占比摊到实测总量上：实测比读数多出来的字节（扫描没走到的）按大小分摊，全为 0 时均分。 */
  const sizes = list.map((item) => (sum > 0 ? (item.bytes / sum) * total : total / Math.max(1, live)))
  /* 一段至少留 0.2%：几百字节的那几格按比例在几百像素的条上会被压没，人眼只看到一道缝。 */
  const widths = sizes.map((size) => (size > 0 ? Math.max(0.2, (size / total) * 100) : 0))
  const scale = widths.reduce((acc, width) => acc + width, 0)

  return list.map((item, index) => ({
    label: item.label,
    series: index === list.length - 1 ? -1 : index % SERIES_INKS,
    bytes: item.bytes,
    caption: item.bytes >= TINY ? formatBytes(item.bytes) : `${item.bytes} 字节`,
    share: scale > 0 ? ((widths[index] ?? 0) / scale) * 100 : 0,
  }))
}

export function StorageBar({
  entries,
  total,
}: {
  readonly entries: readonly StorageEntry[]
  readonly total: number
}): ReactElement {
  const segments = storageSegments(entries, total)

  return (
    <div className="settings-storage">
      {/* 条只画形状：图例就在下面一格，读数与标签都在那里。 */}
      <div aria-hidden="true" className="settings-storage__bar">
        {segments.map((segment) => (
          <span
            className="settings-storage__segment"
            data-series={segment.series}
            key={segment.label}
            style={{ inlineSize: `${segment.share}%` }}
          />
        ))}
      </div>

      <dl className="settings-storage__legend">
        {segments.map((segment) => (
          <div className="settings-storage__item" key={segment.label}>
            <dt>
              <span aria-hidden="true" className="settings-storage__swatch" data-series={segment.series} />
              {segment.label}
            </dt>
            <dd data-unmeasured={segment.bytes === 0 ? 'true' : undefined}>{segment.caption}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
