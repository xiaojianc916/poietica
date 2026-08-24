import { useCallback, useState } from 'react'
import { scrolledToEdge, scrollTargetOf } from './nested-scroll'

/** 人接手视口的那些手势。 */
const HUMAN_EVENTS = ['touchstart', 'keydown', 'pointerdown'] as const

/** 展开与收起会改几何，但那不是人在滚。 */
const DISCLOSURE = '[aria-expanded]'

/**
 * 视口位置的写入者。实现是虚拟器 —— 所以这一层不认识 scrollTop。
 */
export interface ScrollCommands {
  readonly isAtEnd: () => boolean
  readonly toEnd: () => void
  readonly toRow: (row: number) => void
}

export interface ScrollAuthority {
  /** 末端还有没有没看见的内容。判据在虚拟器，这里只是它的一次采样。 */
  readonly atLatest: boolean
  /** 人要求看的那一行；落定或被人接手后回到 null。 */
  readonly revealing: number | null
  /** 采一次末端判据。调用方在它每帧那一次布局读取里唤起，不额外问一次几何。 */
  readonly sample: () => void
  /** 回到最新。 */
  readonly travel: () => void
  /** 去看某一行。 */
  readonly reveal: (row: number) => void
  /** 接管视口上的人机仲裁，交回卸载函数。 */
  readonly watch: (viewport: HTMLElement) => () => void
}

/**
 * 会话流的滚动意图。
 *
 * 只回答两件事：末端是不是还有没看见的内容，人此刻要求看哪一行。一次跳转在半路被
 * 人的手势接手，请求当场作废；位置本身从头到尾归虚拟器写。
 */
export function useScrollAuthority(commands: ScrollCommands): ScrollAuthority {
  const [atLatest, setAtLatest] = useState(true)
  const [revealing, setRevealing] = useState<number | null>(null)

  const sample = useCallback(() => {
    setAtLatest(commands.isAtEnd())
  }, [commands])

  const travel = useCallback(() => {
    setRevealing(null)
    commands.toEnd()
  }, [commands])

  const reveal = useCallback(
    (row: number) => {
      setRevealing(row)
      commands.toRow(row)
    },
    [commands],
  )

  const watch = useCallback(
    (viewport: HTMLElement) => {
      /* 行内自己滚的盒子还能滚，这一笔就不是冲着视口来的。 */
      const wheel = (event: WheelEvent) => {
        const box = scrollTargetOf(viewport, event.target)

        if (box !== viewport && !scrolledToEdge(box, event.deltaY)) {
          return
        }

        setRevealing(null)
      }

      const human = (event: Event) => {
        if (event.target instanceof Element && event.target.closest(DISCLOSURE) !== null) {
          return
        }

        setRevealing(null)
      }

      /* 滚动停了就是请求落定了：不再有第二套「到达」判据。 */
      const settle = () => {
        setRevealing(null)
        setAtLatest(commands.isAtEnd())
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
    },
    [commands],
  )

  return { atLatest, reveal, revealing, sample, travel, watch }
}
