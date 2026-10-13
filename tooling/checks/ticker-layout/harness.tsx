/// <reference lib="dom" />
/// <reference path="../../../packages/design-system/src/css.d.ts" />

import '../../../packages/design-system/src/styles.css'
import '../../../features/conversation/src/ui/components/timeline/flow-row.css'
import '../../../features/conversation/src/ui/components/timeline/ticker/rolling-line.css'

import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { readThoughtSentence } from '../../../features/conversation/src/ui/components/semantics/thought-sentence'
import { RollingLine } from '../../../features/conversation/src/ui/components/timeline/ticker/rolling-line'
import { measureFrame, type Sample } from './recorder'
import { type Arrival, THOUGHT } from './streams'

/*
 * 思考行的真实布局检查台（§8.4）。
 *
 * 用的是仓库里**真实的** RollingLine、readThoughtSentence 与设计令牌，外面套与
 * tool-group-card 纯思考分支完全一样的结构：
 *
 *   section.timeline-group > div.timeline-row[data-measure="prose"] > RollingLine
 *
 * 这一台在真实 Chromium 里跑（见 run.ts），所以「最新的字有没有被裁」「放得下时句首有没有
 * 被吃」量得出来 —— 这正是 happy-dom 做不到、也让 v1 全绿的那一部分。
 */

declare global {
  interface Window {
    __samples?: Sample[]
    __arrivals?: readonly Arrival[]
    /** 当前句身份的变化序列，用来算「同一句」的区间（key 是句子的起始偏移） */
    __key?: { at: number; key: number }[]
    __ready?: boolean
    /** 时基零点：采样与到达时刻都相对它算 */
    __started?: number
    /** 这一场的来字都印出来了、滑行也停了：run.ts 据此收尾，不用干等固定时长 */
    __done?: boolean
  }
}

/** 这一屏的来字节奏由 URL 参数给：run.ts 一个场景一个 page。 */
function streamFromQuery(): {
  readonly arrivals: readonly Arrival[]
  readonly resize: boolean
  readonly reduced: boolean
} {
  const params = new URLSearchParams(location.search)
  const raw = params.get('arrivals')

  return {
    arrivals: raw === null ? [] : (JSON.parse(raw) as Arrival[]),
    resize: params.get('resize') === '1',
    reduced: params.get('reduced') === '1',
  }
}

/**
 * 一帧一采：rAF 之后排一个 setTimeout(0)，那时这一帧已经画完，量到的就是人看到的那一帧。
 *
 * `doneAt` 是这一场来字的尽头（原文长度）：屏幕上印到这里、且没有滑行在跑，就把 `__done`
 * 立起来。run.ts 靠它收尾 —— 干等一个够长的固定时长会让检查台慢，等太短又会把收尾的帧
 * 当成稳态。
 */
function startRecorder(started: () => number, doneAt: number): () => void {
  const samples = window.__samples ?? []
  const keys = window.__key ?? []

  window.__samples = samples
  window.__key = keys
  let stopped = false

  const tick = (): void => {
    if (stopped) return

    requestAnimationFrame(() => {
      setTimeout(() => {
        /* 采样与到达用同一个时基：都相对挂载那一刻算。 */
        const sample = measureFrame(keys, () => performance.now() - started())

        if (sample !== null) {
          samples.push(sample)
          if (sample.key + sample.shown >= doneAt && sample.offset === 0) window.__done = true
        }
        tick()
      }, 0)
    })
  }

  tick()

  return () => {
    stopped = true
  }
}

function Harness({
  arrivals,
  resize,
  reduced,
}: {
  readonly arrivals: readonly Arrival[]
  readonly resize: boolean
  readonly reduced: boolean
}) {
  const [reached, setReached] = useState(0)
  const started = useRef(performance.now())

  const sentences = readThoughtSentence(THOUGHT.slice(0, reached))
  const text = sentences.current.text === '' ? '正在思考' : sentences.current.text
  const key = Number(sentences.current.key === '' ? 0 : sentences.current.key)
  const lineKey = `thought:${String(key)}`

  useEffect(() => {
    const keys = window.__key ?? []

    window.__key = keys
    const at = performance.now() - started.current

    /* 同一批里 React 可能重渲染几遍：只有偏移真的换了才算一次身份变化。 */
    if (keys[keys.length - 1]?.key === key) return

    keys.push({ at, key })
  }, [key])

  useEffect(() => {
    window.__started = started.current
    /* 采样器一上来就要读到达序列算「到这一刻到了多少字」，所以先摆好再起它。 */
    window.__arrivals = arrivals

    const stop = startRecorder(() => started.current, arrivals[arrivals.length - 1]?.length ?? 0)
    const timers: number[] = []

    for (const arrival of arrivals) {
      timers.push(
        window.setTimeout(() => {
          setReached(arrival.length)
        }, arrival.at),
      )
    }

    if (resize) {
      timers.push(
        window.setTimeout(() => {
          document.body.style.width = '520px'
        }, 4000),
        window.setTimeout(() => {
          document.body.style.width = '760px'
        }, 6500),
      )
    }

    window.__ready = true

    return () => {
      stop()

      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [arrivals, resize])

  /* 少动效：把系统偏好摆在根元素上，motion 的 useReducedMotion 读的就是它。 */
  useEffect(() => {
    document.documentElement.dataset.reduced = reduced ? 'true' : 'false'
  }, [reduced])

  return (
    <section className="timeline-group">
      <div className="timeline-row" data-measure="prose">
        <RollingLine
          contentKey={lineKey}
          following
          previous={
            sentences.previous === null
              ? null
              : { key: `thought:${sentences.previous.key}`, text: sentences.previous.text }
          }
          text={text}
          variant="thought"
        />
      </div>
    </section>
  )
}

export function mountHarness(): void {
  const root = document.getElementById('root')

  if (root === null) return

  const stream = streamFromQuery()

  createRoot(root).render(<Harness arrivals={stream.arrivals} reduced={stream.reduced} resize={stream.resize} />)
}
