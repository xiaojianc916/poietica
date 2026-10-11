import { expect, mock, test } from 'bun:test'
import { createViewFrames } from '../view-frames'

/* P-02：帧闸门本身。帧由测试手动推进。 */
function manualFrames() {
  let queued: Array<() => void> = []
  return {
    frame: (run: () => void) => {
      queued.push(run)
      return () => {
        queued = queued.filter((entry) => entry !== run)
      }
    },
    flush: () => {
      const due = queued
      queued = []
      for (const run of due) run()
    },
    get pending() {
      return queued.length
    },
  }
}

test('V1 同一帧内重复 schedule 只请求一帧、只叫一次', () => {
  const frames = manualFrames()
  const gate = createViewFrames(frames.frame)
  const listener = mock(() => {})
  gate.schedule(listener)
  gate.schedule(listener)
  gate.schedule(listener)
  expect(frames.pending).toBe(1)
  expect(listener).not.toHaveBeenCalled()
  frames.flush()
  expect(listener).toHaveBeenCalledTimes(1)
})

test('V2 多个订阅者共用一帧', () => {
  const frames = manualFrames()
  const gate = createViewFrames(frames.frame)
  const a = mock(() => {})
  const b = mock(() => {})
  gate.schedule(a)
  gate.schedule(b)
  expect(frames.pending).toBe(1)
  frames.flush()
  expect(a).toHaveBeenCalledTimes(1)
  expect(b).toHaveBeenCalledTimes(1)
})

test('V3 forget 之后不再叫；全部撤掉时连帧也取消', () => {
  const frames = manualFrames()
  const gate = createViewFrames(frames.frame)
  const listener = mock(() => {})
  gate.schedule(listener)
  gate.forget(listener)
  expect(frames.pending).toBe(0)
  frames.flush()
  expect(listener).not.toHaveBeenCalled()
})

test('V4 回调里再 schedule：排到下一帧，不在本帧里递归', () => {
  const frames = manualFrames()
  const gate = createViewFrames(frames.frame)
  let calls = 0
  const listener = () => {
    calls++
    if (calls === 1) gate.schedule(listener)
  }
  gate.schedule(listener)
  frames.flush()
  expect(calls).toBe(1)
  expect(frames.pending).toBe(1)
  frames.flush()
  expect(calls).toBe(2)
})

test('V5 帧没来就一直不叫（窗口不可见时浏览器不跑 rAF）', () => {
  const frames = manualFrames()
  const gate = createViewFrames(frames.frame)
  const listener = mock(() => {})
  for (let i = 0; i < 1000; i++) gate.schedule(listener)
  expect(listener).not.toHaveBeenCalled()
  expect(frames.pending).toBe(1)
})
