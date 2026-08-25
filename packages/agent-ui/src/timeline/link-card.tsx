import './flow-row.css'
import './shimmer.css'
import './tool-call.css'

import type { LinkTimelineItem } from '@poietica/agent'
import { cx } from '../primitives/class-names'
import { DisclosureBody } from '../primitives/disclosure'
import { ChevronDownIcon, LinkIcon } from '../primitives/icons'

/*
 * 一次断线，长在它耽误的那一轮里，与工具调用同一行形制。
 *
 * 「还断着吗」不由这张卡自己判：它与工具卡片同问 row.isInFlight（判据在
 * presentation.ts 的 inFlight），所以一轮死掉时这里的光会停。
 */

function say(link: LinkTimelineItem['link']): { line: string; detail: string } {
  switch (link.state) {
    case 'retrying':
      return {
        detail: link.reason,
        line: `正在重新连接 ${link.attempt}/${link.of}`,
      }

    case 'recovered':
      return { detail: link.reason, line: '连接已恢复' }

    case 'severed':
      return { detail: link.reason, line: `连接已断开 · 已重试 ${link.attempts} 次` }
  }
}

export function LinkCard({
  isInFlight,
  isOpen,
  item,
  onToggle,
}: {
  readonly isInFlight: boolean
  readonly isOpen: boolean
  readonly item: LinkTimelineItem
  readonly onToggle: () => void
}) {
  const { detail, line } = say(item.link)

  return (
    <section className="timeline-tool" data-open={isOpen ? 'true' : undefined}>
      <button aria-expanded={isOpen} className="timeline-row" onClick={onToggle} type="button">
        <LinkIcon aria-hidden="true" className="timeline-row__icon" />

        <span className={cx('timeline-row__label', isInFlight && 'timeline-shimmer')}>{line}</span>

        <ChevronDownIcon aria-hidden="true" className="timeline-row__chevron disclosure__chevron" />
      </button>

      <DisclosureBody isOpen={isOpen}>
        <p className="timeline-link__detail">{detail}</p>
      </DisclosureBody>
    </section>
  )
}
