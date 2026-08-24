import './flow-row.css'
import './shimmer.css'
import './tool-call.css'

import type { LinkTimelineItem } from '@poietica/agent'
import { cx } from '../primitives/class-names'
import { DisclosureBody } from '../primitives/disclosure'
import { ChevronDownIcon, LinkIcon } from '../primitives/icons'
import { useSecond } from '../primitives/tick'

/*
 * 一次断线，长在它耽误的那一轮里。
 *
 * 与工具调用同一行形制：一枚字形、一句话、指到才出现的箭头；还没接回来的时候
 * 那句话上有一道光扫过。它不戴外框 —— 外框留给需要人回答的东西。
 *
 * 秒数由这一行自己数，所以倒计时不占任何一帧的账：帧里记的是时刻。
 */

const SECOND_MS = 1_000

/** 秒，向上取整，至少 1 —— 倒计时不显示 0s。 */
function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / SECOND_MS))
}

function say(link: LinkTimelineItem['link'], now: number): { line: string; detail: string } {
  switch (link.state) {
    case 'linked':
      return { detail: '连接已恢复。', line: '已重新连接' }

    case 'waiting':
      return {
        detail: `最后一帧到现在 ${String(seconds(Math.max(now - link.since, 0)))}s。`,
        line: '模型仍未响应',
      }

    case 'retrying':
      return {
        detail: `${String(seconds(Math.max(link.retryAt - now, 0)))}s 后重试 · ${link.reason}`,
        line: `正在重新连接 ${String(link.attempt)}/${String(link.of)}`,
      }
  }
}

export function LinkCard({
  isOpen,
  item,
  onToggle,
}: {
  readonly isOpen: boolean
  readonly item: LinkTimelineItem
  readonly onToggle: () => void
}) {
  const isLive = item.link.state !== 'linked'
  const now = useSecond(isLive)
  const { detail, line } = say(item.link, now)

  return (
    <section className="timeline-tool" data-open={isOpen ? 'true' : undefined}>
      <button aria-expanded={isOpen} className="timeline-row" onClick={onToggle} type="button">
        <LinkIcon aria-hidden="true" className="timeline-row__icon" />

        <span className={cx('timeline-row__label', isLive && 'timeline-shimmer')}>{line}</span>

        <ChevronDownIcon aria-hidden="true" className="timeline-row__chevron disclosure__chevron" />
      </button>

      <DisclosureBody isOpen={isOpen}>
        <p className="timeline-link__detail">{detail}</p>
      </DisclosureBody>
    </section>
  )
}
