import { type RefObject, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { StreamdownProps } from 'streamdown'

import { syncWave } from './wave-dom'
import { createWaveReveal } from './wave-reveal'

type RehypeChain = NonNullable<StreamdownProps['rehypePlugins']>

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
const readReducedMotion = (): boolean => window.matchMedia(REDUCED_MOTION).matches
const readReducedMotionOnServer = (): boolean => true
const canAnimate = (): boolean => typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function'

export interface WaveBinding {
  /** display: contents 的一层：syncWave 只扫它的子树 */
  readonly hostRef: RefObject<HTMLDivElement | null>
  readonly rehypePlugins: RehypeChain
  /** 插件链换了必须配一个 className 变化 —— Streamdown 外层 memo 不比较 rehypePlugins，只换链不会重渲 */
  readonly active: boolean
}

/** 流式正文的批次波浪淡入；「减少动态」或无 Web Animations 时不挂，正文立即实显 */
export function useWaveReveal(base: RehypeChain, streaming: boolean): WaveBinding {
  const [wave] = useState(() => createWaveReveal())
  /* 链只建一次：身份稳定，Streamdown 的块 memo 才命中 */
  const [chain] = useState<RehypeChain>(() => [...base, wave.attacher])
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, readReducedMotion, readReducedMotionOnServer)
  const enabled = !reducedMotion && canAnimate()
  const [lingering, setLingering] = useState(false)
  const active = enabled && (streaming || lingering)
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (streaming) {
      setLingering(true)
      return
    }
    const wait = wave.busyUntil() - performance.now()
    if (wait <= 0) {
      setLingering(false)
      return
    }
    const timer = window.setTimeout(() => setLingering(false), wait)
    return () => window.clearTimeout(timer)
  }, [streaming, wave])

  useLayoutEffect(() => {
    if (!active) return
    wave.arm()
    return () => wave.disarm()
  }, [active, wave])

  /* 故意不写依赖数组：每次提交之后、绘制之前都要给新出现的小段挂动画 */
  useLayoutEffect(() => {
    if (active && hostRef.current !== null) syncWave(hostRef.current)
  })

  return { active, hostRef, rehypePlugins: active ? chain : base }
}
