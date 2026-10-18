import './flow-row.css'
import './retry-status.css'
import './ticker/shimmer.css'
import './tools/tool-call.css'

import { cn, useCopy } from '@poietica/design-system'
import { DisclosureBody } from '../../shared/primitives/disclosure'
import { CheckIcon, ChevronDownIcon, CopyIcon, RetryFailedIcon, RetryIcon } from '../../shared/primitives/icons'
import type { RetryTimelineItem } from '../../shared/timeline/timeline-contract'

/** 连着几次报一样的错算一条：「第 1–3 次请求」+ 那句报错 */
interface ErrorRun {
  readonly from: number
  readonly to: number
  readonly text: string
}

function runsOf(item: RetryTimelineItem): readonly ErrorRun[] {
  const runs: ErrorRun[] = []
  item.errors.forEach((text, index) => {
    const request = index + 1
    const last = runs.at(-1)
    if (last !== undefined && last.text === text) runs[runs.length - 1] = { ...last, to: request }
    else runs.push({ from: request, to: request, text })
  })
  return runs
}

const requestsOf = (run: ErrorRun): string =>
  run.from === run.to ? `第 ${String(run.from)} 次请求` : `第 ${String(run.from)}–${String(run.to)} 次请求`

function labelOf(item: RetryTimelineItem): string {
  switch (item.state) {
    case 'running':
      return item.maxAttempts > 0 ? `正在重试 ${String(item.attempt)}/${String(item.maxAttempts)}` : '正在重试…'
    case 'cancelled':
      return '已停止重试'
    case 'failed':
      return item.attempt > 0 ? `重试 ${String(item.attempt)} 次仍失败` : '请求失败'
  }
}

/** 展开那一面：每次请求的报错原文，连着相同的合成一条；复制给的是同样的内容 */
function ErrorLog({ runs }: { readonly runs: readonly ErrorRun[] }) {
  const { copied, copy } = useCopy()
  const failed = runs.reduce((count, run) => count + run.to - run.from + 1, 0)
  const text = runs.map((run) => `${requestsOf(run)}：${run.text}`).join('\n\n')

  return (
    <>
      <div className="timeline-retry-status__head">
        <span className="timeline-retry-status__caption">{`${String(failed)} 次请求失败`}</span>

        <button
          aria-label={copied ? '报错已复制' : '复制报错'}
          className="timeline-retry-status__copy"
          data-copied={copied ? 'true' : undefined}
          onClick={() => copy(text)}
          onMouseDown={(event) => event.preventDefault()}
          type="button"
        >
          {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>

      <ol className="timeline-retry-status__log">
        {runs.map((run) => (
          <li className="timeline-retry-status__entry" key={run.from}>
            <span className="timeline-retry-status__when">{requestsOf(run)}</span>
            <span className="timeline-retry-status__error">{run.text === '' ? '（没有报错信息）' : run.text}</span>
          </li>
        ))}
      </ol>
    </>
  )
}

/*
 * 自动重试那一格，与工具调用同一套行：字形 + 一句话 + 悬停才出现的箭头，在重试时那句话走同一道微光。
 * 一次重试过程只占一行，次数原地往上走（「正在重试 1/5」→「2/5」）；成功了这一行就不在了（投影不给），
 * 次数用完停在「重试 5 次仍失败」。每次请求的报错在展开那一面；一条都没有就只是一行状态，不给点了没反应的按钮。
 */
export function RetryStatus({
  isOpen,
  item,
  onToggle,
}: {
  readonly isOpen: boolean
  readonly item: RetryTimelineItem
  readonly onToggle: () => void
}) {
  const runs = runsOf(item)
  const Glyph = item.state === 'failed' ? RetryFailedIcon : RetryIcon
  const content = (
    <>
      <Glyph aria-hidden="true" className="timeline-row__icon" />

      <span className={cn('timeline-row__label', item.state === 'running' && 'timeline-shimmer')}>{labelOf(item)}</span>
    </>
  )

  if (runs.length === 0) {
    return (
      <section className="timeline-tool" data-retry={item.state}>
        <div className="timeline-row">{content}</div>
      </section>
    )
  }

  return (
    <section className="timeline-tool" data-retry={item.state}>
      <button aria-expanded={isOpen} className="timeline-row" onClick={onToggle} type="button">
        {content}

        <ChevronDownIcon aria-hidden="true" className="timeline-row__chevron disclosure__chevron" />
      </button>

      <DisclosureBody isOpen={isOpen}>
        <div className="timeline-tool__body">
          <div className="timeline-tool__panel" data-scrollable="">
            <ErrorLog runs={runs} />
          </div>
        </div>
      </DisclosureBody>
    </section>
  )
}
