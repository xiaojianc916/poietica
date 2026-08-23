import './flow-row.css'
import './shimmer.css'

import { useCallback, useEffect, useRef } from 'react'
import { ThinkingIcon } from '../primitives/icons'

/** 只印正在写的那一行。 */
function tailLine(text: string): string {
  const written = text.trimEnd()
  const last = written.lastIndexOf('\n')

  return last === -1 ? written : written.slice(last + 1)
}

/** 一次卷动隔几帧。三帧约 20 次/秒，快到眼睛读不出跳格，又不必每个 chunk 都量一次布局。 */
const PACE_FRAMES = 3

/**
 * 跟着到达率走的节流。
 *
 * 字来得密就每三帧对齐一次，来得稀就来一次对一次 —— 速度由 token 决定，不由定时器决定，
 * 所以慢连接下不会空转。读 scrollWidth 会强制同步布局，这一次因此必须落在帧里。
 */
function useFramePaced(update: () => void): () => void {
  const latest = useRef(update)
  const pending = useRef<number | null>(null)

  latest.current = update

  useEffect(
    () => () => {
      if (pending.current !== null) {
        cancelAnimationFrame(pending.current)
        pending.current = null
      }
    },
    [],
  )

  return useCallback(() => {
    if (pending.current !== null) {
      return
    }

    let left = PACE_FRAMES

    const advance = (): void => {
      left -= 1

      if (left > 0) {
        pending.current = requestAnimationFrame(advance)

        return
      }

      pending.current = null
      latest.current()
    }

    pending.current = requestAnimationFrame(advance)
  }, [])
}

/**
 * 这一轮的现场：一枚图标、固定的「正在思考」、以及那一行随写随换的字。
 *
 * 它不是转录里的一条 —— 思考不上屏（renderable），这一行的值由 selectLiveThought 供给，
 * 轮次一落定它就没有值，这一行随之卸载。一次性因此是判据的性质，不需要任何清理代码：
 * 重进一条对话读回来的是终态，它不会重现。
 */
export function ThinkingLine({ text }: { readonly text: string }) {
  const lineRef = useRef<HTMLSpanElement | null>(null)
  const line = tailLine(text)

  const follow = useFramePaced(() => {
    const element = lineRef.current

    if (element !== null) {
      element.scrollLeft = element.scrollWidth - element.clientWidth
    }
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: line 是对齐的节拍，字一长一格就要再跟一次；follow 自己读不到它
  useEffect(() => {
    follow()
  }, [follow, line])

  return (
    <div className="timeline-thinking">
      <div className="timeline-row" role="status">
        <ThinkingIcon aria-hidden="true" className="timeline-row__icon" />

        <span className="timeline-row__name">正在思考</span>

        <span aria-hidden="true" className="timeline-row__dot" />

        <span className="timeline-row__label timeline-shimmer" data-follow-end="true" ref={lineRef}>
          {line}
        </span>
      </div>
    </div>
  )
}
