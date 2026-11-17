import { describe, expect, test } from 'bun:test'
import { classifyChildMode } from '../process-mode'

/*
 * 回归：拆分出 poietica-runtime.exe 之后，runtime 入口不再分流 omp 的 worker 选择子，
 * 于是所有 worker 都落到 runRuntimeMode、因缺 --data-root 以退出码 2 结束。
 * eval 子进程起不来 → 回落到 Bun Worker（同样死）→ 报「Failed to initialize isolated JS eval worker:
 * JS eval worker exited」；computer 只经 eval prelude 暴露，跟着整块不可用。
 */
describe('runtime 入口的子模式路由', () => {
  test('omp 的 worker 选择子（子进程型与线程型）必须交回 omp', () => {
    expect(classifyChildMode('__omp_worker_js_eval_process')).toBe('worker')
    expect(classifyChildMode('__omp_worker_js_eval')).toBe('worker')
    expect(classifyChildMode('__omp_worker_computer')).toBe('worker')
    expect(classifyChildMode('__omp_worker_tiny_inference')).toBe('worker')
  })

  test('browser-relay 与维护子进程同样先在 runtime 入口分流', () => {
    expect(classifyChildMode('browser-relay')).toBe('browser-relay')
    expect(classifyChildMode('gc')).toBe('gc')
  })

  test('主模式的实参不被误判成子模式（返回 null = 调用方接着走自己的主模式）', () => {
    expect(classifyChildMode('--data-root')).toBeNull()
    expect(classifyChildMode('runtime')).toBeNull()
    expect(classifyChildMode('serve')).toBeNull()
    expect(classifyChildMode(undefined)).toBeNull()
  })
})
