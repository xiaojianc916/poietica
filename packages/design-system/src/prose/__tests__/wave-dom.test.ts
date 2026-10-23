import { expect, test } from 'bun:test'
import { createWaveSync, syncWave } from '../wave/wave-dom'
import { WAVE } from '../wave/wave-reveal'

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

const span = (start: number) => {
  const el = document.createElement('span')
  el.setAttribute('data-wave-start', String(start))
  el.textContent = '字'
  return el
}

test('D4 增量同步：首次全量，之后只查本次新插入的标记，旧标记不再重看', () => {
  const h = host(Array.from({ length: 1000 }, (_, i) => `<p><span data-wave-start="${i}">字</span></p>`).join(''))
  const sync = createWaveSync(h)
  expect(sync.sync()).toBe(1000)
  const p = document.createElement('p')
  p.append(span(5000))
  h.append(p)
  expect(sync.sync()).toBe(1)
  expect(p.querySelector('span')!.getAnimations()[0]?.startTime).toBe(5000)
  expect(sync.sync()).toBe(0)
  sync.dispose()
})

test('D5 增量同步：节点被复用给另一段（标记时刻变了）照样改钉，不新建动画', () => {
  const h = host('<span data-wave-start="100">字</span>')
  const el = h.querySelector('span')!
  const sync = createWaveSync(h)
  sync.sync()
  el.setAttribute('data-wave-start', '300')
  expect(sync.sync()).toBe(1)
  expect(el.getAnimations()).toHaveLength(1)
  expect(el.getAnimations()[0]?.startTime).toBe(300)
  sync.dispose()
})

test('D6 增量同步：一次插入太多，按文档顺序只让最后 maxFreshPerCommit 个淡入（与 syncWave 同规则）', () => {
  const h = host('')
  const sync = createWaveSync(h)
  sync.sync()
  const n = WAVE.maxFreshPerCommit + 30
  /* 倒着插：记录顺序与文档顺序相反，截取前必须重排 */
  for (let i = n - 1; i >= 0; i--) h.prepend(span(i))
  expect(sync.sync()).toBe(n)
  const spans = [...h.querySelectorAll('span')]
  expect(spans.slice(0, 30).every((s) => s.getAnimations().length === 0)).toBe(true)
  expect(spans.slice(30).every((s) => s.getAnimations().length === 1)).toBe(true)
  sync.dispose()
})

test('D7 增量同步：两次 sync 之间被观察器回调先取走的变动不丢；插入后又删掉的不算', async () => {
  const h = host('')
  const sync = createWaveSync(h)
  sync.sync()
  const kept = span(1)
  const gone = span(2)
  h.append(kept, gone)
  await Promise.resolve()
  gone.remove()
  expect(sync.sync()).toBe(1)
  expect(kept.getAnimations()).toHaveLength(1)
  sync.dispose()
  h.append(span(3))
  expect(sync.sync()).toBe(0)
})
