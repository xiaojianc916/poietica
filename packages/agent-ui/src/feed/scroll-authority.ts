import { useCallback, useState } from 'react'
import { scrolledToEdge, scrollTargetOf } from './nested-scroll'

/** 人接手视口的那些手势。 */
const HUMAN_EVENTS = ['touchstart', 'keydown', 'pointerdown'] as const

/** 展开与收起会改几何，但那不是人在滚。 */
const DISCLOSURE = '[aria-expanded]'

export interface ScrollAuthority {
  /** 末端还有没有没看见的内容。判据在虚拟器，这里只是它的一次采样。 */
  readonly atLatest: boolean
  /**
   * 要不要跟着末端走。这是意图，不是采样：末端的坐标分帧才凑齐（偏移与尾部各等一次
   * ResizeObserver，行高等实测），采样在中途会说「不在末端」，而人并没有接手。
   */
  readonly pinned: boolean
  /** 人要求看的那一行，或上次离开时视线所在的那一行；落定或被人接手后回到 null。 */
  readonly revealing: number | null
  /** 采一次末端判据。调用方在它每帧那一次布局读取里唤起，不额外问一次几何。 */
  readonly sample: (atEnd: boolean) => void
  /** 回到最新。 */
  readonly travel: () => void
  /** 去看某一行。 */
  readonly reveal: (row: number) => void
  /** 接管视口上的人机仲裁，交回卸载函数。 */
  readonly watch: (viewport: HTMLElement, atEnd: () => boolean) => () => void
}

/**
 * 会话流的滚动意图。
 *
 * 只回答三件事：末端是不是还有没看见的内容，要不要跟着末端走，人此刻要求看哪一行。
 * 它不认识写入者 —— 位置从头到尾归虚拟器写，而写的那一处只有一个（见滚动区的布局效应）。
 */
export function useScrollAuthority(
  /** 上次离开这条对话时视线所在的行；null = 上次在末端。 */
  resumeAt: number | null,
): ScrollAuthority {
  /* 初值就是这三样的全部来源：一条对话一个盒子，所以挂载即「打开这条对话」。 */
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
