import { useIsPresent } from 'motion/react'
import { useLayoutEffect, useRef } from 'react'
import { TickerEngine } from './ticker-engine'

/*
 * 一句话的那一格：TickerLine 是还在写的思考句，像显示屏一样往左滚（引擎见 ticker-engine.ts），React 只渲染窗口这一层，
 * 里面的轨道和字归引擎所有；StaticLine（工具行、落定态、占位）不动、从头显示，放不下时末尾省略号 —— 被截掉的只能是末尾。
 */

export interface TickerLineProps {
  readonly text: string
  /** 刚被换上来的新句：从第一个字开始写。首次挂载（含滚出视野再滚回来）为 false：直接摆好，不重播。 */
  readonly fresh: boolean
  /** 下一句在等：加快写完这一句。 */
  readonly finishing: boolean
  readonly reduced: boolean
  readonly ink: boolean
}

export function TickerLine({ text, fresh, finishing, reduced, ink }: TickerLineProps) {
  const host = useRef<HTMLSpanElement | null>(null)
  const engine = useRef<TickerEngine | null>(null)
  /* 只用挂载那一刻的取值建引擎：同一句的整个生命周期一个引擎，后续变化走下面几个副作用。 */
  const initial = useRef({ text, fresh, reduced, ink })
  /* motion 的退场信号：AnimatePresence 开始让这一句退场时为 false。 */
  const present = useIsPresent()

  useLayoutEffect(() => {
    const node = host.current

    if (node === null) return undefined

    const created = new TickerEngine(node, initial.current)

    engine.current = created

    return () => {
      created.dispose()
      engine.current = null
    }
  }, [])

  useLayoutEffect(() => {
    engine.current?.setText(text)
  }, [text])

  useLayoutEffect(() => {
    engine.current?.setFlushing(finishing)
  }, [finishing])

  /* 开始退场：一次写完、停住。退场中的旧句不再滚，保持此刻的样子刷走。 */
  useLayoutEffect(() => {
    if (!present) engine.current?.finish()
  }, [present])

  return <span className="ticker-window" ref={host} />
}

export function StaticLine({ text }: { readonly text: string }) {
  return (
    <span className="ticker-window">
      <span className="ticker-track">{text}</span>
    </span>
  )
}
