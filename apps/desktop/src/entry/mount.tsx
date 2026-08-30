import { StrictMode } from 'react'
import { flushSync } from 'react-dom'
import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import { FatalErrorHost } from '../notice/error-boundary'
import { markReactFatalHostMounted, reportFatalIncident } from '../notice/problem-presentation'
import { AppShell } from '../shell/app-shell'
import { type ApplicationRuntime, createApplicationRuntime } from './compose-runtime'

/*
 * 一次 React 错误的上报口，只有这一个。
 *
 * 此前它挂在 FatalErrorBoundary.componentDidCatch 上，而边界只看得见「被接住的」
 * 那一种；另外两种只有 root 收得到。三条通道分级放在同一处，才谈得上一条管线。
 */
function reportReactError(input: {
  readonly code: string
  readonly collector: string
  readonly componentStack: string | null
  readonly error: unknown
}): void {
  reportFatalIncident({
    impact: 'application-fatal',
    error: input.error,
    kind: 'render',
    phase: 'running',
    code: input.code,
    componentStack: input.componentStack,
    context: {
      collector: input.collector,
    },
  })
}

export function mountReactApplication(
  container: HTMLElement,
  restored: string | null,
): ApplicationRuntime {
  let runtime: ReturnType<typeof createApplicationRuntime>

  try {
    runtime = createApplicationRuntime(restored)
  } catch (error: unknown) {
    reportFatalIncident({
      impact: 'application-fatal',
      error,
      kind: 'bootstrap',
      phase: 'runtime-construction',
      code: 'FATAL_APPLICATION_RUNTIME_CONSTRUCTION',
      context: {
        collector: 'react-root',
      },
    })

    throw error
  }

  const root: Root = createRoot(container, {
    /* 被错误边界接住的那种。报告只挂这一条通道，边界不再自己报，否则一次崩溃记两笔。 */
    onCaughtError: (error, info) => {
      reportReactError({
        code: 'FATAL_REACT_RENDER_ERROR',
        collector: 'react-error-boundary',
        componentStack: info.componentStack ?? null,
        error,
      })
    },

    /*
     * React 自己恢复了的那种：绝不能升级成终止事件。
     *
     * 默认动作是 reportError()，它派发 window 的 error 事件，而 browser-collectors
     * 把任何一次 window error 都记成 impact: 'application-fatal' + recovery:
     * 'reload'，FatalErrorHost 于是立刻用整屏致命页盖掉一个已经自愈的界面。
     * 严重级别在传递途中被翻了一档，接住它就是把这一档要回来。
     */
    onRecoverableError: (error, info) => {
      console.warn('[Poietica] React 从一次错误中恢复', error, info.componentStack)
    },

    /*
     * 没有任何边界接住的那种。
     *
     * 默认同样绕 reportError() 走到 window，于是一次渲染崩溃被采集器归档成
     * kind: 'async' 的异步失败，而 ErrorEvent 上没有组件栈 —— 诊断里最有用的
     * 那一段就此丢掉。从 root 直接收，两样都对得上。
     */
    onUncaughtError: (error, info) => {
      reportReactError({
        code: 'FATAL_REACT_UNCAUGHT_ERROR',
        collector: 'react-root',
        componentStack: info.componentStack ?? null,
        error,
      })
    },
  })

  markReactFatalHostMounted()

  /* 首帧同步提交：窗口以 visible: false 创建，呈现要等这一帧的 DOM 在位。 */
  flushSync(() => {
    root.render(
      <StrictMode>
        <FatalErrorHost>
          <AppShell runtime={runtime} />
        </FatalErrorHost>
      </StrictMode>,
    )
  })

  return runtime
}
