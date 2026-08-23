import './turn-seal.css'

import type { TimelineItemId } from '@poietica/agent'
import { ChevronDown } from 'lucide-react'
import { memo, useEffect, useState } from 'react'

/*
 * 一轮的封条：这一轮花了多久，以及它的过程收在哪里。
 *
 * 它不是一条时间线条目 —— 它不来自任何一帧，它是「这一轮」本身的标签，所以它长在行的
 * 外面（transcript-view 的 renderRowAt）。横线是它自己的下边框：过程不是它的
 * 孩子，摊开多少行都不会把这条线推走。
 */

export interface TurnSealProps {
  /** 折叠状态的键：开启这一轮的那条提问。 */
  readonly id: TimelineItemId
  /** 缺席表示这台机器没有记下这一轮的两端：不报耗时，也不空转秒表。 */
  readonly startedAt: number | undefined
  /** 有起点而缺终点，就是这一轮还在跑。 */
  readonly endedAt: number | undefined
  readonly hasProcess: boolean
  readonly isOpen: boolean
  readonly onToggle: (id: TimelineItemId) => void
}

const SECOND_MS = 1_000

/*
 * 耗时读的是墙钟，因为两端都是墙钟。
 *
 * 起止取自日志里的 at（原生侧 recorder.rs 的 now_millis 写下的 epoch 毫秒），所以这里
 * 只能拿 Date.now() 与它相减；performance.now() 的原点是每个进程各自的，与日志里的时刻
 * 不在同一条数轴上。
 *
 * 落定之后不起定时器：一个不会再变的数字不需要每秒醒一次。运行中每秒重读时钟，而不是
 * 把一个计数器加一 —— 定时器会被节流（后台窗口、系统休眠），累加会漂，重读不会。
 */
function useElapsed(
  startedAt: number | undefined,
  endedAt: number | undefined,
): number | undefined {
  /* 没有起点就没有秒表可走：起不起定时器与报不报耗时是同一个事实。 */
  const running = startedAt !== undefined && endedAt === undefined
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    if (!running) {
      return
    }

    const tick = setInterval(() => {
      setNow(Date.now())
    }, SECOND_MS)

    return () => {
      clearInterval(tick)
    }
  }, [running])

  return startedAt === undefined ? undefined : Math.max((endedAt ?? now) - startedAt, 0)
}

/*
 * 三档：一分钟以内只说秒，一小时以内说分和秒，再长只说时和分。
 *
 * 不补零 —— 读的人认的是「多少分多少秒」，不是一个时刻。
 */
function spell(ms: number): string {
  const total = Math.floor(ms / SECOND_MS)
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60

  if (hours > 0) {
    return `${String(hours)}h ${String(minutes)}m`
  }

  if (minutes > 0) {
    return `${String(minutes)}m ${String(seconds)}s`
  }

  return `${String(seconds)}s`
}

/*
 * 文案只说耗时，不说成败。
 *
 * 一轮以失败结束时，协议给出的 stopReason 与正常结束的那一轮相同：上游
 * turnEndReasonToStopReason 把 failed 也映成 end_turn，它的注释说 ACP 的 StopReason 里
 * 没有 failed 这个变体。所以这里没有可靠依据说「失败」，说了就是编。出错这件事由这一轮
 * 里那条 error 条目自己讲，它就在下面几行。
 */
function Seal({ endedAt, hasProcess, id, isOpen, onToggle, startedAt }: TurnSealProps) {
  const elapsed = useElapsed(startedAt, endedAt)

  /*
   * 不知道的耗时不编一个出来。
   *
   * 重放回来的历史里没有时刻（协议不带这一格），本机账本没盖住的那些轮次因此算不出耗
   * 时。此前它们一律显示「已处理 0s」—— 那个 0 是把「历史被读回来」的那一瞬间当成了整
   * 整一轮的长度，一个说得斩钉截铁的假数。缺了就只说这里收着过程。
   */
  const label =
    elapsed === undefined
      ? '过程'
      : `${endedAt === undefined ? '正在处理' : '已处理'} ${spell(elapsed)}`

  /*
   * 横线与交互控件分开。
   *
   * 横线仍然横贯整列，但 hover 和点击命中区只属于里面真正可操作的按钮，
   * 不再因为鼠标经过这一整行而变色。
   */
  if (!hasProcess) {
    return (
      <div className="turn-seal-line">
        <p className="turn-seal">
          <span className="turn-seal__label">{label}</span>
        </p>
      </div>
    )
  }

  return (
    <div className="turn-seal-line">
      <button
        aria-expanded={isOpen}
        className="turn-seal turn-seal--toggle"
        onClick={() => {
          onToggle(id)
        }}
        type="button"
      >
        <span className="turn-seal__label">{label}</span>
        <ChevronDown aria-hidden="true" className="turn-seal__chevron" />
      </button>
    </div>
  )
}

/*
 * 属性全是原始值，所以浅比较真的挡得住：流式期间整棵转录每帧协调一次，而一条已经落定
 * 的封条一个字都不会变。
 */
export const TurnSeal = memo(Seal)
