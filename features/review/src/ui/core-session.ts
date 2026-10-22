import type { UiFeatureContext } from '@poietica/ui-kernel'

/*
 * Core 的「第几世」：每丢一次 Core（崩溃、手动重启）世代加一，新的 Core 就绪时通知订阅者（首次启动不算）。
 *
 * 审查的 git.watch 是 Core 进程里的计数：Core 一重启计数清零，界面却还以为在听 —— 面板从此不再自动刷新，直到被卸载重挂。
 * 订阅者据此在新的一世里重发一次。按功能上下文各一份（WeakMap）：组件手里只有 ctx，不必把它一层层往下传。
 */
export interface CoreSession {
  generation(): number
  onRenewed(listener: () => void): () => void
}

type Lifecycle = Pick<UiFeatureContext['lifecycle'], 'onCoreLost' | 'onCoreReady'>

export function createCoreSession(lifecycle: Lifecycle): CoreSession {
  let generation = 0
  let announced = 0
  const listeners = new Set<() => void>()
  lifecycle.onCoreLost(() => {
    generation += 1
  })
  lifecycle.onCoreReady(() => {
    if (announced === generation) return
    announced = generation
    for (const listener of [...listeners]) listener()
  })
  return {
    generation: () => generation,
    onRenewed(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const sessions = new WeakMap<object, CoreSession>()

/** 这个功能上下文的那一份；setup 里先取一次，世代从装配那一刻算起。 */
export function coreSessionOf(ctx: { readonly lifecycle: Lifecycle }): CoreSession {
  const held = sessions.get(ctx)
  if (held !== undefined) return held
  const session = createCoreSession(ctx.lifecycle)
  sessions.set(ctx, session)
  return session
}
