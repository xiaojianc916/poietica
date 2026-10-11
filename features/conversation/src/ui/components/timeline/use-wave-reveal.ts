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
/* 没有窗口的环境一律当「减少动态」：不挂插件 */
const readReducedMotionOnServer = (): boolean => true
const canAnimate = (): boolean => typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function'

export interface WaveBinding {
  /** 包住 Streamdown 的那层（display: contents）；syncWave 只扫它的子树 */
  readonly hostRef: RefObject<HTMLDivElement | null>
  readonly rehypePlugins: RehypeChain
  /**
   * 波浪是否挂着。插件链换了必须配一个 className 变化 —— Streamdown 外层 memo
   * 不比较 rehypePlugins，只换链不会重渲。
   */
  readonly active: boolean
}

/**
 * 流式正文的批次波浪淡入（P-03）。
 *
 * - streaming 期间挂上插件链，结束后再等最后一波淡完才摘（busyUntil），最后几个字不会被截断；
 * - 系统「减少动态」或没有 Web Animations 时不挂，正文立即实显；
 * - 首个挂插件的提交只记账：此前已有的字（切回会话、虚拟列表重新挂载）不重播。
 */
export function useWaveReveal(base: RehypeChain, streaming: boolean): WaveBinding {
  const [wave] = useState(() => createWaveReveal())
  /* base 是模块常量；链只建一次，身份稳定，Streamdown 的块 memo 才命中 */
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

  /* 每次提交之后、绘制之前：给新出现的小段挂动画并钉住启动时刻 */
  useLayoutEffect(() => {
    if (active && hostRef.current !== null) syncWave(hostRef.current)
  })

  return { active, hostRef, rehypePlugins: active ? chain : base }
}
