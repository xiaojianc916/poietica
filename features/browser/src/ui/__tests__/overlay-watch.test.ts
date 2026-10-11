import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { overlayPresent, watchOverlays } from '../overlay-watch'

/*
 * P-07：浮层观察只看 body 的直接子节点与应用根（#root）之外的传送门子树。
 * 流式输出时 #root 里每秒几十次的 DOM 变动不应该叫醒浏览器面板（O1 在旧逻辑上失败）。
 */

/** MutationObserver 的回调在微任务里批量派发 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let root: HTMLElement
let stops: Array<() => void> = []

beforeEach(() => {
  document.body.replaceChildren()
  root = document.createElement('div')
  root.id = 'root'
  document.body.append(root)
})

afterEach(() => {
  for (const stop of stops) stop()
  stops = []
  document.body.replaceChildren()
})

function watch(): ReturnType<typeof mock> {
  const onChange = mock(() => {})
  stops.push(watchOverlays(document, onChange))
  return onChange
}

function portal(open: boolean): { host: HTMLElement; popup: HTMLElement } {
  const host = document.createElement('div')
  const popup = document.createElement('div')
  popup.setAttribute('role', 'dialog')
  if (open) popup.setAttribute('data-open', '')
  host.append(popup)
  document.body.append(host)
  return { host, popup }
}

test('O1 应用根里的大量变动不触发回调', async () => {
  const onChange = watch()
  for (let i = 0; i < 200; i++) {
    const span = document.createElement('span')
    span.setAttribute('data-open', '')
    span.textContent = String(i)
    root.append(span)
  }
  root.firstElementChild?.removeAttribute('data-open')
  await flush()
  expect(onChange).not.toHaveBeenCalled()
})

test('O2 传送门出现、移除都触发；出现时判为有浮层', async () => {
  const onChange = watch()
  const { host } = portal(true)
  await flush()
  expect(onChange).toHaveBeenCalled()
  expect(overlayPresent(document)).toBe(true)
  onChange.mockClear()
  host.remove()
  await flush()
  expect(onChange).toHaveBeenCalled()
  expect(overlayPresent(document)).toBe(false)
})

test('O3 传送门里 data-open 的开合触发回调', async () => {
  const { popup } = portal(false)
  const onChange = watch()
  expect(overlayPresent(document)).toBe(false)
  popup.setAttribute('data-open', '')
  await flush()
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(overlayPresent(document)).toBe(true)
  popup.removeAttribute('data-open')
  await flush()
  expect(onChange).toHaveBeenCalledTimes(2)
  expect(overlayPresent(document)).toBe(false)
})

test('O4 后加入的传送门里，弹层晚一步挂上也能被看到', async () => {
  const onChange = watch()
  const host = document.createElement('div')
  document.body.append(host)
  await flush()
  onChange.mockClear()
  const popup = document.createElement('div')
  popup.setAttribute('role', 'dialog')
  popup.setAttribute('data-open', '')
  host.append(popup)
  await flush()
  expect(onChange).toHaveBeenCalled()
  expect(overlayPresent(document)).toBe(true)
})

test('O5 应用根里的 role=dialog 不算浮层（全仓没有不走传送门的对话框）', () => {
  const inline = document.createElement('div')
  inline.setAttribute('role', 'dialog')
  inline.setAttribute('data-open', '')
  root.append(inline)
  expect(overlayPresent(document)).toBe(false)
})

test('O6 没带 data-open 的自建 role=dialog（上下文仪表）不算浮层，与旧行为一致', () => {
  const host = document.createElement('div')
  const gauge = document.createElement('div')
  gauge.setAttribute('role', 'dialog')
  host.append(gauge)
  document.body.append(host)
  expect(overlayPresent(document)).toBe(false)
})

test('O7 停止之后不再回调', async () => {
  const onChange = mock(() => {})
  watchOverlays(document, onChange)()
  portal(true)
  await flush()
  expect(onChange).not.toHaveBeenCalled()
})

test('O8 找不到应用根时退回整树观察（行为与旧逻辑相同）', async () => {
  root.removeAttribute('id')
  const onChange = watch()
  const inline = document.createElement('div')
  inline.setAttribute('role', 'dialog')
  inline.setAttribute('data-open', '')
  root.append(inline)
  await flush()
  expect(onChange).toHaveBeenCalled()
  expect(overlayPresent(document)).toBe(true)
})
