import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { Profiler } from 'react'
import type { Transcript, TranscriptStore } from '../transcript-store'
import { TranscriptsContext } from '../transcripts-context'
import { useAssistantTimeline } from '../use-assistant-session'

/*
 * P-02：视图按帧合并。转录每 16ms 到一批、每批是一个独立的宏任务（一条 IPC 消息）；
 * 旧实现每批都同步渲染一次，窗口不可见时也照画。新实现一帧最多渲染一次，帧不来就不画。
 *
 * 帧由测试手动推进：把 requestAnimationFrame 换成一个队列（view-frames 在调用时查全局）。
 */

let frames: Array<() => void> = []
const realRaf = globalThis.requestAnimationFrame
const realCancel = globalThis.cancelAnimationFrame

beforeEach(() => {
  frames = []
  globalThis.requestAnimationFrame = ((run: FrameRequestCallback) =>
    frames.push(() => run(0))) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((handle: number) => {
    frames[handle - 1] = () => undefined
  }) as typeof cancelAnimationFrame
})

afterEach(() => {
  cleanup()
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCancel
})

/** 推进一帧：跑掉此刻排着的帧回调 */
const nextFrame = () =>
  act(() => {
    const due = frames
    frames = []
    for (const run of due) run()
  })

/** 一条 IPC 消息 = 一个宏任务 */
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0))

function fakeStore() {
  let version = 0
  let current = { timeline: { version } } as unknown as Transcript
  const listeners = new Set<() => void>()
  const store = {
    read: () => current,
    subscribe: (_key: string, listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    store: store as unknown as TranscriptStore,
    listeners,
    /** Core 送来一批：事实立刻更新、同步通知 */
    push() {
      version += 1
      current = { timeline: { version } } as unknown as Transcript
      for (const listener of [...listeners]) listener()
    },
  }
}

function Probe() {
  const timeline = useAssistantTimeline('t1') as unknown as { version: number }
  return <output>{timeline.version}</output>
}

function mount(store: TranscriptStore) {
  let commits = 0
  const view = render(
    <TranscriptsContext.Provider value={store}>
      <Profiler id="probe" onRender={() => commits++}>
        <Probe />
      </Profiler>
    </TranscriptsContext.Provider>,
  )
  return { view, commits: () => commits }
}

test('F1 帧没来（窗口不可见）时，50 批数据一次都不渲染；来一帧只渲染一次、且是最新', async () => {
  const fake = fakeStore()
  const { view, commits } = mount(fake.store)
  const before = commits()
  for (let i = 0; i < 50; i++) {
    await act(async () => {
      fake.push()
      await macrotask()
    })
  }
  expect(commits() - before).toBe(0)
  await nextFrame()
  expect(commits() - before).toBe(1)
  expect(view.container.textContent).toBe('50')
})

test('F2 同一帧里多批到达只渲染一次', async () => {
  const fake = fakeStore()
  const { view, commits } = mount(fake.store)
  const before = commits()
  await act(async () => {
    fake.push()
    await macrotask()
    fake.push()
    await macrotask()
    fake.push()
  })
  await nextFrame()
  expect(commits() - before).toBe(1)
  expect(view.container.textContent).toBe('3')
})

test('F3 等帧期间卸载：帧来了也不碰已卸载的组件，订阅已全部退掉', async () => {
  const fake = fakeStore()
  const { view } = mount(fake.store)
  await act(async () => fake.push())
  view.unmount()
  expect(fake.listeners.size).toBe(0)
  await nextFrame()
})
