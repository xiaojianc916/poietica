import { useSyncExternalStore } from 'react'

/*
 * 一台秒表，整个界面共用。
 *
 * 有人订就每秒走一拍，最后一个人走了就停：定时器的数量不随屏幕上有几处在计时而增长，
 * 同一秒里所有读者也读到同一个数。外部可变源接进 React 的形状就是 useSyncExternalStore。
 */

const SECOND_MS = 1_000

const listeners = new Set<() => void>()

let timer: ReturnType<typeof setInterval> | undefined
let now = Date.now()

function tick(): void {
  now = Date.now()

  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  if (timer === undefined) {
    now = Date.now()
    timer = setInterval(tick, SECOND_MS)
  }

  listeners.add(listener)

  return () => {
    listeners.delete(listener)

    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

function stopped(): () => void {
  return () => {}
}

const reading = (): number => now

/* 不计时的读者恒读同一个数：快照必须稳定，否则每次渲染都会被判成「变了」。 */
const frozen = (): number => 0

/** 每秒一拍的本机时刻；ticking 为假时不订阅、也不读时钟。 */
export function useSecond(ticking: boolean): number {
  return useSyncExternalStore(ticking ? subscribe : stopped, ticking ? reading : frozen)
}
