/// <reference lib="dom" />

/*
 * 真实布局检查的取数：每帧在 rAF 之后、绘制之后取一次字与窗口的矩形、轨道宽度、当前句身份。
 * 取字用 Range —— 只有它给的是字形本身的框，元素的框在 overflow: hidden 下量不出「被裁掉的那截」。
 */

import type { Sample } from './metrics'

export type { Sample }

export interface GlyphRects {
  readonly firstL: number
  readonly lastR: number
  readonly text: string
}

export function glyphRects(track: HTMLElement): GlyphRects | null {
  const walker = document.createTreeWalker(track, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []

  while (walker.nextNode()) {
    const node = walker.currentNode

    if (node instanceof Text && node.data.length > 0) nodes.push(node)
  }

  const first = nodes[0]
  const last = nodes[nodes.length - 1]

  if (first === undefined || last === undefined) return null

  const range = document.createRange()

  range.setStart(first, 0)
  range.setEnd(first, 1)

  const firstRect = range.getBoundingClientRect()
  let end = last.data.length

  while (end > 0 && /\s/u.test(last.data[end - 1] ?? '')) end -= 1

  range.setStart(last, Math.max(0, end - 1))
  range.setEnd(last, end)

  const lastRect = range.getBoundingClientRect()

  return { firstL: firstRect.left, lastR: lastRect.right, text: nodes.map((node) => node.data).join('') }
}

function shownCount(track: HTMLElement): number {
  let count = 0

  for (const node of track.childNodes) count += node.textContent?.length ?? 0

  return count
}

/** 空串或别的形式算 0（引擎静止时就是这么写的）。 */
function offsetOf(track: HTMLElement): number {
  const parsed = /translate3d\(\s*(-?[\d.]+)px/u.exec(track.style.transform)

  return parsed === null ? 0 : Number.parseFloat(parsed[1] ?? '0')
}

function arrivedAt(t: number): number {
  let arrived = 0

  for (const arrival of window.__arrivals ?? []) {
    if (arrival.at > t) break
    arrived = arrival.length
  }

  return arrived
}

/** `data-line-key` 的尾巴：`thought:52` / 组头里的 `thought:<id>:52`。 */
function displayedOffset(slot: HTMLElement): number | null {
  const key = slot.dataset.lineKey
  const tail = key?.slice(key.lastIndexOf(':') + 1) ?? ''
  const offset = Number.parseInt(tail, 10)

  return Number.isNaN(offset) ? null : offset
}

/** 采样里记的是屏幕上那一句的句首偏移：延迟要量「这一批的字有没有印出来」。 */
function offsetAt(
  slot: HTMLElement,
  keys: readonly { readonly at: number; readonly key: number }[],
  t: number,
): number {
  const displayed = displayedOffset(slot)

  if (displayed !== null) return displayed

  let key = 0

  for (const entry of keys) {
    if (entry.at <= t) key = entry.key
  }

  return key
}

/**
 * 只测当前句：不带 `data-motion-pop-id` 的 `.rolling-line__slot` —— 那个属性是 motion 给退场句的
 * （popLayout 把它摘成绝对定位）。
 */
export function measureFrame(
  keys: readonly { readonly at: number; readonly key: number }[],
  now: () => number,
): Sample | null {
  const slot = document.querySelector<HTMLElement>('.rolling-line__slot:not([data-motion-pop-id])')
  const track = slot?.querySelector<HTMLElement>('.ticker-track')
  const win = slot?.querySelector<HTMLElement>('.ticker-window')

  if (slot === null || track == null || win == null) return null

  const rects = glyphRects(track)

  if (rects === null) return null

  const box = win.getBoundingClientRect()
  const t = now()
  const key = offsetAt(slot, keys, t)

  return {
    t,
    key,
    shown: shownCount(track),
    arrived: arrivedAt(t),
    firstL: rects.firstL,
    lastR: rects.lastR,
    winL: box.left,
    winR: box.right,
    winW: box.width,
    trackW: track.getBoundingClientRect().width,
    offset: offsetOf(track),
    text: rects.text,
    shownKey: `${String(key)}:${slot.dataset.lineKey ?? ''}`,
  }
}
