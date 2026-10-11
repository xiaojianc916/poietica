import { expect, test } from 'bun:test'
import { syncWave } from '../wave-dom'
import { WAVE } from '../wave-reveal'

function host(html: string): HTMLElement {
  const div = document.createElement('div')
  div.innerHTML = html
  document.body.append(div)
  return div
}

test('D1 给小段挂淡入并把 startTime 钉在标记的时刻', () => {
  const h = host('<p>旧字<span data-wave-start="1234.5">新字</span></p>')
  syncWave(h)
  const [animation] = h.querySelector('span')!.getAnimations()
  expect(animation?.startTime).toBe(1234.5)
})

test('D2 同一元素同一时刻再 sync 不新建动画；时刻变了就改钉同一条', () => {
  const h = host('<span data-wave-start="100">字</span>')
  const span = h.querySelector('span')!
  syncWave(h)
  syncWave(h)
  expect(span.getAnimations()).toHaveLength(1)
  span.setAttribute('data-wave-start', '200')
  syncWave(h)
  expect(span.getAnimations()).toHaveLength(1)
  expect(span.getAnimations()[0]?.startTime).toBe(200)
})

test('D3 一次提交新来太多：只有最后 maxFreshPerCommit 个淡入，前面的直接实显', () => {
  const n = WAVE.maxFreshPerCommit + 30
  const h = host(Array.from({ length: n }, (_, i) => `<span data-wave-start="${i}">字</span>`).join(''))
  syncWave(h)
  const spans = [...h.querySelectorAll('span')]
  expect(spans.slice(0, 30).every((s) => s.getAnimations().length === 0)).toBe(true)
  expect(spans.slice(30).every((s) => s.getAnimations().length === 1)).toBe(true)
})
