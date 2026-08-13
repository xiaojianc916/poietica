import { useCallback, useState } from 'react'

/**
 * 什么算"人自己动了手"。
 *
 * 一次程序化跳转会连续产生几十个 scroll 事件,所以 scroll 不在此列 —— 用它
 * 判定意图,闩锁会被跳转自己解开。这四个是输入设备事件:它们只可能由人产生。
 *
 * 声明成 readonly string[] 而不是字面量元组:addEventListener 的重载按事件名
 * 收窄监听器类型,喂给它一个联合字面量会让重载解析失败,而这里用的是同一个
 * 无参监听器。
 */
const RELEASING_EVENTS: readonly string[] = ['wheel', 'touchstart', 'keydown', 'pointerdown']

export interface RevealIntent {
  /** 尚未了结的跳转要去的行;没有则为 null。 */
  readonly pending: number | null
  readonly begin: (row: number) => void
  /**
   * 报告视口顶端此刻是哪一行、它的顶边贴没贴齐。两者同时成立才了结。
   *
   * 判据是顶行而不是视线行:跳转用 align 'start',它的语义就是"目标行顶边贴齐
   * 视口顶边"。但顶行相等只说了一半 —— 向上跳时视口从目标行的下边进入它的区间,
   * 那一刻顶行已经等于目标行,而落点还差着最多一整行;只看顶行,了结会把位移半路
   * 掐断。贴齐与否由观察方拿同一次几何读取交来,这里不碰几何。
   */
  readonly settle: (topRow: number, flush: boolean) => void
  /** 装到滚动区上,返回卸载函数。 */
  readonly watch: (viewport: HTMLElement) => () => void
}

/**
 * 一次跳转在了结之前,一直是它说了算。
 *
 * 缩略导航平时从滚动位置反推高亮,这在人自己滚的时候是对的。但点击跳转期间它
 * 是错的:落点尚未稳定,反推出来的是路上经过的轮次,于是高亮会在跳转的那一瞬间
 * 扫过一串别的轮次 —— 那就是"乱跳"被看见的地方。
 *
 * 所以跳转期间高亮的真源换人:由这次点击说了算。它有两种结局,而不是一种 ——
 * 到达,或者被放弃。只留"被放弃"是设计缺陷:那条路依赖输入事件必然发生,而拖动
 * 原生滚动条是否派发 pointerdown 并无保证;一旦漏掉,闩锁就永久挂着,连带把流式
 * 跟随也一直关着。到达是自终止的,不依赖任何人再做什么。
 *
 * 状态是一个行号,不是一个带序号的对象。曾经加过一个自增序号,理由是"让重复点击
 * 同一行也产生新身份" —— 但未落地时重复点同一行本来就该是空操作(已经在去那儿
 * 了),而落地后 pending 已置 null,再点是 null → n,身份自然变化。那个序号从未被
 * 任何代码读过。
 *
 * 也没有镜像 ref。监听器只装一次,读不到最新的 state,这是真问题 —— 但官方答案
 * 是把更新写成函数,更新器拿得到当前值;返回同一个值 React 就直接短路。手写一个
 * ref 去镜像 state,是在给自己制造两个真源。
 */
export function useRevealIntent(): RevealIntent {
  const [pending, setPending] = useState<number | null>(null)

  const begin = useCallback((row: number) => {
    setPending(row)
  }, [])

  const abandon = useCallback(() => {
    setPending(null)
  }, [])

  const settle = useCallback((topRow: number, flush: boolean) => {
    setPending((current) => (current === topRow && flush ? null : current))
  }, [])

  const watch = useCallback(
    (viewport: HTMLElement) => {
      for (const name of RELEASING_EVENTS) {
        viewport.addEventListener(name, abandon, { passive: true })
      }

      return () => {
        for (const name of RELEASING_EVENTS) {
          viewport.removeEventListener(name, abandon)
        }
      }
    },
    [abandon],
  )

  return { pending, begin, settle, watch }
}
