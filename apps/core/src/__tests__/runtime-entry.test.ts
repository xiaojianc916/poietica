import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const source = readFileSync(path.join(import.meta.dir, '..', 'runtime-entry.ts'), 'utf8')

/*
 * 钉子：omp 的 worker 线程与 IPC 子进程都用 workerHostEntry()（编译版 = Bun.main）重新进入这个 exe。
 * 入口必须在 runtime 主模式之前把选择子交回 omp，否则 worker 会走进 runtime 模式并在
 * 「缺少 --data-root」处 exit(2) —— eval 报「JS eval worker exited」，computer 跟着不可用。
 */
describe('runtime-entry 的分流顺序', () => {
  test('先调 dispatchChildMode，再动态导入 runtime 主模式', () => {
    const dispatch = source.indexOf('await dispatchChildMode()')
    const runtime = source.indexOf("await import('./runtime-main')")
    expect(dispatch).toBeGreaterThan(-1)
    expect(runtime).toBeGreaterThan(-1)
    expect(dispatch).toBeLessThan(runtime)
  })

  test('启动环境快照仍先于分流：worker 也要拿到同一份清洗后的环境', () => {
    const capture = source.indexOf('captureLaunchEnv()')
    const dispatch = source.indexOf('await dispatchChildMode()')
    expect(capture).toBeGreaterThan(-1)
    expect(capture).toBeLessThan(dispatch)
  })
})
