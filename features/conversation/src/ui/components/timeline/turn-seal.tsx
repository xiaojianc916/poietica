import './turn-seal.css'
import { memo } from 'react'
import type { TurnOutcome } from '../../timeline/timeline-contract'
import { ChevronDownIcon } from '../primitives/icons'
import { formatRunDuration } from '../semantics/duration'

/**
 * 一轮**结束之后**压在过程上方的那条封条（DSH TurnProcessNodeView）。
 *
 * 它只在轮结束之后存在（那一轮还没完时由转录末尾的运行状态行说话），所以这里没有秒针：
 * 报的是一段已经定下来的时长，不是「到现在为止多久」。
 *
 * 文案由这一轮**怎么结束的**解出：被打断报「已停止」、出错报「处理失败」—— 两者都不报时长，
 * 那一刻的长度不是这条封条要说的事；正常答完才报「已完成，用时 N」。
 */
export interface TurnSealProps {
  readonly turn: number
  readonly outcome: TurnOutcome | undefined
  readonly durationMs: number | undefined
  readonly startedAt: number | undefined
  readonly endedAt: number | undefined
  readonly isOpen: boolean
  /** 能不能点着折叠（DSH 的 canCollapse：有过程、且不满足「永远摊开」）。 */
  readonly canCollapse: boolean
  readonly onToggle: (turn: number, isOpen: boolean) => void
}

/** DSH 的时长下限：不足一秒也报 1 秒，屏幕上不出现「0秒」。 */
const MIN_RUN_MS = 1_000

function elapsedOf(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end)) {
    return undefined
  }
  return Math.max(end - start, 0)
}

/** 三档终局文案。轮没报终局（老载荷 / 缺这一格）时按正常答完算，不编一个「失败」出来。 */
function phaseOf(outcome: TurnOutcome | undefined): string {
  if (outcome === 'aborted') {
    return '已停止'
  }
  if (outcome === 'error') {
    return '处理失败'
  }

  return '已完成'
}

function Seal({ canCollapse, durationMs, endedAt, isOpen, onToggle, outcome, startedAt, turn }: TurnSealProps) {
  /* 终态不能用最后一次观察时间冒充实际终点；agent 报的总时长优先，缺席才拿两头相减兜底。 */
  const elapsed = durationMs ?? elapsedOf(startedAt, endedAt)
  const phase = phaseOf(outcome)
  /* 打断与出错不报时长：那一刻的长度不是这条封条要说的事。 */
  const timed = outcome !== 'aborted' && outcome !== 'error'
  const duration = elapsed === undefined || !timed ? null : formatRunDuration(Math.max(MIN_RUN_MS, elapsed))
  /* 数字与单位分开成格：只有数字换等宽字，前缀那几个汉字跟着正文走（DSH 的 durationNumber）。 */
  const label = (
    <>
      {duration === null ? phase : `${phase}，用时 `}
      {duration?.map((part, index) => (
        <span className={part.numeric ? 'turn-seal__number' : undefined} key={index}>
          {part.text}
        </span>
      ))}
    </>
  )

  return (
    <div className="turn-seal-line">
      {/* 可访问名钉死成结论那一句：数字不该进 live 区，报的是「这一轮怎么了」。 */}
      <span aria-atomic="true" aria-live="polite" className="turn-seal__announce" role="status">
        {phase}
      </span>

      {canCollapse ? (
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
      ) : (
        <p className="turn-seal">
          <span className="turn-seal__label">{label}</span>
        </p>
      )}
    </div>
  )
}

export const TurnSeal = memo(Seal)
