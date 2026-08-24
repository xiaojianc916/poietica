import { linkNotice } from '@poietica/agent'
import type { SessionLink } from '@poietica/agent-contract'
import './turn-seal.css'

import { memo } from 'react'
import { ChevronDownIcon } from '../primitives/icons'
import { useSecond } from '../primitives/tick'

/*
 * 一轮的封条：这一轮花了多久，以及它的过程收在哪里。
 *
 * 它不是一条时间线条目 —— 它不来自任何一帧，它是「这一轮」本身的标签，所以它长在行的
 * 外面（transcript-view 的 renderRowAt）。横线是它自己的下边框：过程不是它的
 * 孩子，摊开多少行都不会把这条线推走。
 */

export interface TurnSealProps {
  /** 这条连接此刻的链路态。只画在跑着的那一轮旁边；接着的时候是 null。 */
  readonly link: SessionLink | null
  readonly turn: number
  /** 缺席表示这台机器没有记下这一轮的两端：不报耗时，也不空转秒表。 */
  readonly startedAt: number | undefined
  /** 日志记录到的终点，只负责耗时。 */
  readonly endedAt: number | undefined
  /** 运行中的耗时以它为终点。缺席表示这一轮还没收到过任何一帧。 */
  readonly lastFrameAt: number | undefined
  readonly hasProcess: boolean
  readonly isRunning: boolean
  readonly isOpen: boolean
  /** 交出人要的那个状态，不是一次翻转：默认开合由投影按运行事实给，这里不复制它。 */
  readonly onToggle: (turn: number, isOpen: boolean) => void
}

const SECOND_MS = 1_000

/*
 * 耗时的两端同在日志域：起点是 run_started 的 at，终点是这一轮最后一帧的 at，两者都由
 * 原生侧 recorder.rs 的 now_millis 写下。
 *
 * 本机时钟只有一个入口：这一轮还在跑。那时它与日志同轴 —— 同一台机器、同一个 epoch
 * 毫秒。装载回来的、被停掉的那些轮次一律只读日志。
 */
function elapsedOf(
  startedAt: number | undefined,
  endedAt: number | undefined,
  lastFrameAt: number | undefined,
): number | undefined {
  const until = endedAt ?? lastFrameAt

  if (startedAt === undefined || until === undefined) {
    return undefined
  }

  return Math.max(until - startedAt, 0)
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
function Seal({
  endedAt,
  hasProcess,
  isOpen,
  isRunning,
  lastFrameAt,
  link,
  onToggle,
  startedAt,
  turn,
}: TurnSealProps) {
  const now = useSecond(isRunning)
  const elapsed = elapsedOf(
    startedAt,
    endedAt,
    isRunning ? Math.max(now, lastFrameAt ?? 0) : lastFrameAt,
  )
  const phase = isRunning ? '正在处理' : '已处理'
  const label = elapsed === undefined ? phase : `${phase} ${spell(elapsed)}`

  /* 链路态成句在 @poietica/agent 的 linkNotice 里：这里只把那句话画出来。 */
  const notice = link === null ? null : linkNotice(link, now)

  /* 运行中不会折叠；没有过程时也没有可操作的 disclosure。 */
  if (isRunning || !hasProcess) {
    return (
      <div className="turn-seal-line">
        <p className="turn-seal">
          <span className="turn-seal__label">{label}</span>
          {notice === null ? null : <span className="turn-seal__link">{notice}</span>}
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
          onToggle(turn, !isOpen)
        }}
        type="button"
      >
        <span className="turn-seal__label">{label}</span>
        <ChevronDownIcon aria-hidden="true" className="turn-seal__chevron" />
      </button>
    </div>
  )
}

/*
 * 属性全是原始值，所以浅比较真的挡得住：流式期间整棵转录每帧协调一次，而一条已经落定
 * 的封条一个字都不会变。
 */
export const TurnSeal = memo(Seal)
