import { describe, expect, test } from 'bun:test'
import type { Element, ElementContent, Root, RootContent } from 'hast'
import { createWaveReveal, WAVE, WAVE_MARKER_ATTRIBUTE, WAVE_START_ATTRIBUTE } from '../wave/wave-reveal'

/* 批次波浪淡入的纯函数部分（P-03）：时钟可注入，直接喂手搭的 hast 树。 */

const text = (value: string): ElementContent => ({ type: 'text', value })
const el = (tagName: string, children: ElementContent[] = [], properties: Element['properties'] = {}): Element => ({
  type: 'element',
  tagName,
  properties,
  children,
})
const root = (...children: ElementContent[]): Root => ({ type: 'root', children })
const para = (value: string): Root => root(el('p', [text(value)]))

function setup(options = WAVE) {
  const clock = { t: 1000 }
  const wave = createWaveReveal(options, () => clock.t)
  const transform = wave.attacher()
  const run = (tree: Root): Root => {
    transform(tree)
    return tree
  }
  return { clock, wave, run }
}

/* 树里所有带启动时刻的 span。 */
function waves(tree: Root | Element): Array<[string, number]> {
  const out: Array<[string, number]> = []
  const walk = (node: Root | Element) => {
    for (const child of node.children) {
      if (child.type !== 'element') continue
      const start = child.properties?.[WAVE_START_ATTRIBUTE]
      if (start !== undefined) out.push([textOf(child), Number(start)])
      else walk(child)
    }
  }
  walk(tree)
  return out
}
const textOf = (node: RootContent | Root): string =>
  node.type === 'text' ? node.value : 'children' in node ? node.children.map(textOf).join('') : ''

const CHARS = '流式输出的时候新到的文字应该像一道波一样淡入前面的先变实后面的跟上'
const chars = (n: number) => Array.from({ length: n }, (_, i) => CHARS[i % CHARS.length]).join('')

describe('wave-reveal', () => {
  test('W1 未 arm：只记账，不打标记', () => {
    const { run } = setup()
    expect(waves(run(para(chars(40))))).toEqual([])
  })

  test('W2 arm 前已有的字不动画，只有新到的字进波', () => {
    const { wave, run, clock } = setup()
    run(para(chars(40)))
    wave.arm()
    clock.t = 1016
    const tree = run(para(chars(52)))
    const got = waves(tree)
    expect(got.map(([s]) => s).join('')).toBe(chars(52).slice(40))
    expect(got.map(([, start]) => start)).toEqual([1016, 1046])
    expect(textOf(tree)).toBe(chars(52))
  })

  test('W3 一批 60 字：10 段、每段 ≥6 字、依次启动、240ms 内铺开', () => {
    const { wave, run } = setup()
    run(para(''))
    wave.arm()
    const got = waves(run(para(chars(60))))
    expect(got).toHaveLength(10)
    for (const [s] of got) expect(s.length).toBeGreaterThanOrEqual(6)
    const starts = got.map(([, start]) => start)
    for (let i = 1; i < starts.length; i++) expect(starts[i]!).toBeGreaterThan(starts[i - 1]!)
    expect(starts.at(-1)! - starts[0]!).toBeLessThanOrEqual(WAVE.spreadMs)
  })

  test('W4 突发 300 字：封顶 24 段，仍在 240ms 内铺开（不是一大片同时出现）', () => {
    const { wave, run } = setup()
    run(para(''))
    wave.arm()
    const starts = waves(run(para(chars(300)))).map(([, start]) => start)
    expect(starts).toHaveLength(WAVE.maxSegments)
    expect(new Set(starts).size).toBe(WAVE.maxSegments)
    expect(starts.at(-1)! - starts[0]!).toBeLessThanOrEqual(WAVE.spreadMs)
  })

  test('W5 跨批首尾相接：下一批接在上一波后面启动', () => {
    const { wave, run, clock } = setup()
    run(para(''))
    wave.arm()
    const first = waves(run(para(chars(60)))).map(([, s]) => s)
    clock.t += 16
    const all = waves(run(para(chars(66)))).map(([, s]) => s)
    const next = all.slice(first.length)
    expect(next).toHaveLength(1)
    expect(next[0]!).toBeGreaterThan(first.at(-1)!)
  })

  test('W6 积压有上限：同一时刻连来十批，没有字晚于 now+2×spread 才启动', () => {
    const { wave, run, clock } = setup()
    run(para(''))
    wave.arm()
    let n = 0
    let tree = para('')
    for (let i = 0; i < 10; i++) {
      n += 300
      tree = run(para(chars(n)))
    }
    for (const [, start] of waves(tree)) expect(start).toBeLessThanOrEqual(clock.t + 2 * WAVE.spreadMs)
  })

  test('W7 淡完的字并回普通文本', () => {
    const { wave, run, clock } = setup()
    run(para(''))
    wave.arm()
    run(para(chars(60)))
    clock.t += WAVE.spreadMs + WAVE.fadeMs + WAVE.settleMarginMs + 1
    const got = waves(run(para(chars(61))))
    expect(got.map(([s]) => s)).toEqual([chars(61).slice(60)])
  })

  test('W8 有界：3000 字每 33ms 来 3 字，任意时刻在飞 span ≤ 16', () => {
    const { wave, run, clock } = setup()
    run(para(''))
    wave.arm()
    let peak = 0
    for (let n = 3; n <= 3000; n += 3) {
      clock.t += 33
      peak = Math.max(peak, waves(run(para(chars(n)))).length)
    }
    expect(peak).toBeLessThanOrEqual(16)
  })

  test('W9 按字素切：组合表情与带附加符号的字不被切开', () => {
    const { wave, run } = setup()
    run(para('前缀'))
    wave.arm()
    const family = '👨‍👩‍👧'
    const got = waves(run(para(`前缀${family.repeat(7)}é`)))
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    for (const [s] of got) {
      for (const { segment } of segmenter.segment(s)) expect([family, 'é']).toContain(segment)
    }
  })

  test('W10 末尾改写（未闭合的强调补全）仍算同一块，不把整块重淡', () => {
    const { wave, run, clock } = setup()
    const prefix = '这是一段已经显示了好一会儿的前缀文字'
    run(root(el('p', [text(`${prefix}**未闭`)])))
    wave.arm()
    clock.t += 16
    const got = waves(run(root(el('p', [text(prefix), el('strong', [text('未闭合')])]))))
    expect(got.map(([s]) => s).join('')).toBe('未闭合')
  })

  test('W11 结构：pre 不拆；行内 code 外包 span；新列表项打 marker；img 打属性', () => {
    const { wave, run } = setup()
    run(root(el('p', [text('开头')])))
    wave.arm()
    const pre = el('pre', [el('code', [text('const x = 1')])])
    const code = el('code', [text('inline')])
    const img = el('img', [], { src: 'poietica-asset://a.png' })
    const li = el('li', [text('新的一项')])
    const tree = run(root(el('p', [text('开头'), code, img]), pre, el('ul', [li])))
    expect(textOf(pre)).toBe('const x = 1')
    expect(pre.children[0]).toEqual(el('code', [text('const x = 1')]))
    const p = tree.children[0] as Element
    const wrapper = p.children[1] as Element
    expect(wrapper.tagName).toBe('span')
    expect(wrapper.properties?.[WAVE_START_ATTRIBUTE]).toBeDefined()
    expect(wrapper.children[0]).toBe(code)
    expect(img.properties?.[WAVE_START_ATTRIBUTE]).toBeDefined()
    expect(li.properties?.[WAVE_MARKER_ATTRIBUTE]).toBeDefined()
  })

  test('W12 超大批（从后台切回）：只给末尾 hugeTail 个字做动画', () => {
    const { wave, run } = setup()
    run(para(''))
    wave.arm()
    const animated = waves(run(para(chars(4000)))).reduce((sum, [s]) => sum + s.length, 0)
    expect(animated).toBeLessThanOrEqual(WAVE.hugeTail)
  })

  test('W13 插件名唯一（Streamdown 按插件名缓存处理器）', () => {
    const a = createWaveReveal().attacher.name
    const b = createWaveReveal().attacher.name
    expect(a).toStartWith('rehypeWaveReveal$')
    expect(a).not.toBe(b)
  })

  test('W14 disarm 后重新挂上：先记账再 arm，已有的字不重播', () => {
    const { wave, run } = setup()
    run(para(''))
    wave.arm()
    run(para(chars(60)))
    wave.disarm()
    expect(wave.busyUntil()).toBe(0)
    run(para(chars(60)))
    wave.arm()
    expect(waves(run(para(chars(60))))).toEqual([])
  })

  test('W15 busyUntil 覆盖最后一段的淡入', () => {
    const { wave, run } = setup()
    run(para(''))
    wave.arm()
    const last = waves(run(para(chars(60)))).at(-1)![1]
    expect(wave.busyUntil()).toBeGreaterThanOrEqual(last + WAVE.fadeMs)
  })
})
