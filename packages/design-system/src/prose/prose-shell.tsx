import { clsx } from 'clsx'
import { memo, type ReactNode, useEffect, useSyncExternalStore } from 'react'
import 'streamdown/styles.css'
import './prose.css'
import type { ProseProps } from './prose'

/*
 * 正文渲染的轻壳（性能方案 P5）：实现（./prose）连同 streamdown、remark / rehype 链、parse5、
 * shiki 与 pele 约 2.4MB，在独立分块里由宿主首帧后空闲预取；真来不及的那一下按源码原样显示、
 * 到达后换成排版（与公式插件同一处置）。样式留在轻壳上：两份 CSS 仍随入口进主样式表，覆盖次序
 * 与拆分前相同 —— 放进分块会晚插进 <head>，反过来压住后面的同权重规则（R-49 同此）。
 */

type ProseModule = typeof import('./prose')
type Phase = 'idle' | 'loading' | 'ready' | 'failed'

const loadImpl = (): Promise<ProseModule> => import('./prose')

let load = loadImpl
let impl: ProseModule | undefined
let phase: Phase = 'idle'
let pending: Promise<void> | undefined
/* 第一次加载有了结果（到了或到不了）就置真、此后不回落：失败后的重试不能把已经放行的那一层再收回去。 */
let settledOnce = false
let generation = 0
let prefetchScheduled = false
const listeners = new Set<() => void>()

function settle(next: Phase): void {
  phase = next
  settledOnce = true
  for (const listener of [...listeners]) listener()
}

/**
 * 加载实现；同一时刻只有一次在途。失败时清掉在途的那一份，下一次触发（下一次挂载、下一次预取）重试；
 * 期间正文保持源码显示，不抛进渲染。
 */
export function preloadProse(): Promise<void> {
  if (pending !== undefined) return pending
  const at = generation
  phase = 'loading'
  pending = load().then(
    (module) => {
      /* 复位后晚到的结果作废，不把清过的状态写回来（同 loadMath）。 */
      if (at !== generation) return
      impl = module
      settle('ready')
    },
    (cause: unknown) => {
      if (at === generation) {
        pending = undefined
        settle('failed')
      }
      throw cause
    },
  )
  return pending
}

/**
 * 首帧之后空闲时预取一次。只为把第一段正文的等待挪走：失败了交给 report，挂载时还会按需再试。
 * 宿主在首帧画完之后调用（例如入口表面的 effect 里）；同一次启动里多次调用只排一次。
 */
export function prefetchProseWhenIdle(report?: (cause: unknown) => void): void {
  if (prefetchScheduled || phase === 'ready' || pending !== undefined) return
  prefetchScheduled = true
  const run = (): void => {
    void preloadProse().catch((cause: unknown) => {
      prefetchScheduled = false
      report?.(cause)
    })
  }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2_000 })
  else setTimeout(run, 0)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const currentImpl = (): ProseModule | undefined => impl
/*
 * 「到了」或「到不了」都算落定：到不了时正文按源码显示，不能让等它的那一层一直空着。落定只看第一次有没有结果，
 * 不看当前 phase：失败之后的重试会把 phase 拨回 loading，若跟着回落，已经画出来的时间线会整段消失再出现。
 */
const isSettled = (): boolean => settledOnce

/** 挂载时还没有就按需加载一次；失败已由预取那一处上报，这里不重复报。 */
function useLoadOnMount(needed: boolean): void {
  useEffect(() => {
    if (needed) void preloadProse().catch(() => undefined)
  }, [needed])
}

/**
 * 正文渲染是否已落定（实现到了，或者确定到不了）。按行高定位的列表（会话时间线）用它把第一次挂载压到
 * 落定之后：否则那一下先按源码量一次高、再按排版量一次，位置跟着跳。
 */
export function useProseSettled(): boolean {
  const settled = useSyncExternalStore(subscribe, isSettled)
  useLoadOnMount(!settled)
  return settled
}

/* 实现到达之前：同一个外壳、同一组类名，正文按源码原样显示（保留换行）。 */
function ProseSource({ className, text }: ProseProps): ReactNode {
  return (
    <div className="timeline-prose-host">
      <div className={clsx('timeline-prose', 'timeline-prose--source', className)}>{text}</div>
    </div>
  )
}

export const Prose = memo(function Prose(props: ProseProps) {
  const current = useSyncExternalStore(subscribe, currentImpl)
  useLoadOnMount(current === undefined)
  if (current === undefined) return <ProseSource {...props} />
  return <current.Prose {...props} />
})

export type { ProseProps } from './prose'

/**
 * 测试用复位：bun test 各测试文件共享同一份模块实例，别的文件先渲染过正文会让「到达之前」看见脏状态。
 * `loader` 换掉动态 import，用来造「加载失败」「迟到」这些真机上难以复现的时序。
 */
export function resetProseForTests(loader: () => Promise<ProseModule> = loadImpl): void {
  generation += 1
  load = loader
  impl = undefined
  phase = 'idle'
  pending = undefined
  settledOnce = false
  prefetchScheduled = false
}
