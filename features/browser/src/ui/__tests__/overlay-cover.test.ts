import { afterEach, expect, test } from 'bun:test'
import { registerOverlay } from '@poietica/design-system'
import { type Box, coveredNow, coversView, watchCover } from '../overlay-cover'

/* 原生视图让路的判定（P-07）：模态浮层一律让，贴边浮层只在和视图相交时让。 */

const VIEW: Box = { left: 800, top: 100, right: 1400, bottom: 900 }
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))

function boxed(box: Box): Element {
  const element = document.createElement('div')
  element.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top })
  return element
}

const boxOf = (element: Element): Box => element.getBoundingClientRect()

const unregisters: Array<() => void> = []
afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister()
})

test('OC1 模态浮层不看几何，一律算盖住（视图还没占位时也是）', () => {
  expect(coversView([{ kind: 'modal' }], VIEW, boxOf)).toBe(true)
  expect(coversView([{ kind: 'modal' }], null, boxOf)).toBe(true)
})

test('OC2 贴边浮层只在与视图相交时算盖住；只是挨着边不算', () => {
  const over = boxed({ left: 1200, top: 80, right: 1300, bottom: 200 })
  const elsewhere = boxed({ left: 100, top: 100, right: 400, bottom: 300 })
  const touching = boxed({ left: 700, top: 100, right: 800, bottom: 200 })
  expect(coversView([{ kind: 'anchored', element: over }], VIEW, boxOf)).toBe(true)
  expect(coversView([{ kind: 'anchored', element: elsewhere }], VIEW, boxOf)).toBe(false)
  expect(coversView([{ kind: 'anchored', element: touching }], VIEW, boxOf)).toBe(false)
  expect(coversView([{ kind: 'anchored', element: over }], null, boxOf)).toBe(false)
})

test('OC3 watchCover：模态浮层当场让路、走了当场回来；起步回调一次当前值', () => {
  const seen: boolean[] = []
  const stop = watchCover(
    () => boxed(VIEW),
    (covered) => seen.push(covered),
  )
  expect(seen).toEqual([false])

  const unregister = registerOverlay({ kind: 'modal' })
  expect(seen).toEqual([false, true])
  expect(coveredNow()).toBe(true)
  unregister()
  expect(seen).toEqual([false, true, false])
  stop()
})

test('OC4 watchCover：贴边浮层推到下一帧再量，相交才让；在场期间每帧重量（跟着挪进视图也认）', async () => {
  const seen: boolean[] = []
  let box: Box = { left: 100, top: 100, right: 300, bottom: 200 }
  const popup = document.createElement('div')
  popup.getBoundingClientRect = () => boxed(box).getBoundingClientRect()
  const stop = watchCover(
    () => boxed(VIEW),
    (covered) => seen.push(covered),
  )

  unregisters.push(registerOverlay({ kind: 'anchored', element: popup }))
  expect(seen).toEqual([false])
  expect(coveredNow()).toBe(false)
  await nextFrame()
  expect(seen).toEqual([false])

  box = { left: 900, top: 120, right: 1100, bottom: 400 }
  await nextFrame()
  await nextFrame()
  expect(seen).toEqual([false, true])

  for (const unregister of unregisters.splice(0)) unregister()
  expect(seen).toEqual([false, true, false])
  stop()
})
