import { type Disposable, toDisposable } from './disposable'

/** 可替换的时钟。产品代码中凡是需要被测试控制的计时都通过 Clock，测试用 test-kit 的 fakeClock() */
export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): Disposable
  setInterval(fn: () => void, ms: number): Disposable
}

export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
  setTimeout(fn: () => void, ms: number): Disposable {
    const handle = setTimeout(fn, ms)
    return toDisposable(() => clearTimeout(handle))
  },
  setInterval(fn: () => void, ms: number): Disposable {
    const handle = setInterval(fn, ms)
    return toDisposable(() => clearInterval(handle))
  },
})
