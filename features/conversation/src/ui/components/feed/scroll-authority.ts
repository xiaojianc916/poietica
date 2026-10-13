import { useCallback, useState } from 'react'
import { scrolledToEdge, scrollTargetOf } from './nested-scroll'

const HUMAN_EVENTS = ['touchstart', 'keydown', 'pointerdown'] as const

const DISCLOSURE = '[aria-expanded]'

export interface ScrollAuthority {
  readonly atLatest: boolean
  /** 是意图不是采样：末端坐标分帧才凑齐，采样在中途会说「不在末端」，而人并没有接手。 */
  readonly pinned: boolean
  readonly revealing: number | null
  readonly sample: (atEnd: boolean) => void
  readonly travel: () => void
  readonly reveal: (row: number) => void
  readonly watch: (viewport: HTMLElement, atEnd: () => boolean) => () => void
}

/** 会话流的滚动意图，不认识写入者：位置从头到尾归虚拟器写，且只有一处写（见滚动区的布局效应）。 */
export function useScrollAuthority(
  /** 上次离开这条对话时视线所在的行；null = 上次在末端。 */
  resumeAt: number | null,
): ScrollAuthority {
  /* 一条对话一个盒子：挂载即「打开这条对话」，初值就是全部来源。 */
  const [atLatest, setAtLatest] = useState(resumeAt === null)
  const [pinned, setPinned] = useState(resumeAt === null)
  const [revealing, setRevealing] = useState<number | null>(resumeAt)

  const sample = useCallback((atEnd: boolean) => {
    setAtLatest(atEnd)
  }, [])

  const travel = useCallback(() => {
    setRevealing(null)
    setPinned(true)
  }, [])

  const reveal = useCallback((row: number) => {
    setRevealing(row)
    setPinned(false)
  }, [])

  const watch = useCallback((viewport: HTMLElement, atEnd: () => boolean) => {
    /* 行内自己滚的盒子还能滚，这一笔就不是冲着视口来的。 */
    const wheel = (event: WheelEvent) => {
      const box = scrollTargetOf(viewport, event.target)

      if (box !== viewport && !scrolledToEdge(box, event.deltaY)) {
        return
      }

      setPinned(false)
      setRevealing(null)
    }

    const human = (event: Event) => {
      /* 手一落在视口上就不再跟随，开合也算：那一刻人看的是被点开的东西。 */
      setPinned(false)

      if (event.target instanceof Element && event.target.closest(DISCLOSURE) !== null) {
        return
      }

      setRevealing(null)
    }

    /* 滚动停了就是请求落定了：不再有第二套「到达」判据。 */
    const settle = () => {
      const end = atEnd()

      setAtLatest(end)
      setPinned(end)
      setRevealing(null)
    }

    viewport.addEventListener('wheel', wheel, { passive: true })
    viewport.addEventListener('scrollend', settle, { passive: true })

    for (const name of HUMAN_EVENTS) {
      viewport.addEventListener(name, human, { passive: true })
    }

    return () => {
      viewport.removeEventListener('wheel', wheel)
      viewport.removeEventListener('scrollend', settle)

      for (const name of HUMAN_EVENTS) {
        viewport.removeEventListener(name, human)
      }
    }
  }, [])

  return { atLatest, pinned, reveal, revealing, sample, travel, watch }
}
