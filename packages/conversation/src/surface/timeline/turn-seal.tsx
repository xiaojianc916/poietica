import './turn-seal.css'
import { memo } from 'react'
import { useSecond } from '../primitives/clock'
import { ChevronDownIcon } from '../primitives/icons'
import { formatDuration } from '../semantics/duration'

export interface TurnSealProps {
  readonly turn: number
  readonly durationMs: number | undefined
  readonly startedAt: number | undefined
  readonly endedAt: number | undefined
  readonly lastFrameAt: number | undefined
  readonly hasProcess: boolean
  readonly isRunning: boolean
  readonly isOpen: boolean
  readonly onToggle: (turn: number, isOpen: boolean) => void
}

function elapsedOf(start: number | undefined, end: number | undefined): number | undefined {
  if (
    start === undefined ||
    end === undefined ||
    !Number.isFinite(start) ||
    !Number.isFinite(end)
  ) {
    return undefined
  }
  return Math.max(end - start, 0)
}

function Seal({
  durationMs,
  endedAt,
  hasProcess,
  isOpen,
  isRunning,
  lastFrameAt,
  onToggle,
  startedAt,
  turn,
}: TurnSealProps) {
  const now = useSecond(isRunning && startedAt !== undefined && Number.isFinite(startedAt))
  // 终态不能用最后一次观察时间冒充实际终点。
  const elapsed = isRunning
    ? elapsedOf(startedAt, Math.max(now, lastFrameAt ?? now))
    : (durationMs ?? elapsedOf(startedAt, endedAt))
  const phase = isRunning ? '正在处理' : '已处理'
  const duration = elapsed === undefined ? null : formatDuration(elapsed)
  const label = duration === null ? `${phase} · 耗时未知` : `${phase} ${duration}`

  if (isRunning || !hasProcess) {
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
        onClick={() => onToggle(turn, !isOpen)}
        type="button"
      >
        <span className="turn-seal__label">{label}</span>
        <ChevronDownIcon aria-hidden="true" className="turn-seal__chevron" />
      </button>
    </div>
  )
}

export const TurnSeal = memo(Seal)
