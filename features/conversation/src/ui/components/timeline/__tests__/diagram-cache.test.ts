import { beforeEach, describe, expect, test } from 'bun:test'
import { cachedInks, cachedSvg, inksKey, keepInks, keepSvg, resetDiagramCacheForTests, svgKey } from '../diagram-cache'
import type { DiagramInks } from '../diagram-theme'

function inksWith(overrides: Partial<DiagramInks> = {}): DiagramInks {
  return {
    background: 'transparent',
    clusterBkg: 'rgb(1, 1, 1)',
    clusterBorder: 'rgb(2, 2, 2)',
    edgeLabelBackground: 'rgb(3, 3, 3)',
    lineColor: 'rgb(4, 4, 4)',
    mainBkg: 'rgb(5, 5, 5)',
    primaryBorderColor: 'rgb(6, 6, 6)',
    primaryColor: 'rgb(7, 7, 7)',
    primaryTextColor: 'rgb(8, 8, 8)',
    secondaryColor: 'rgb(9, 9, 9)',
    tertiaryColor: 'rgb(10, 10, 10)',
    textColor: 'rgb(11, 11, 11)',
    ...overrides,
  }
}

beforeEach(() => {
  resetDiagramCacheForTests()
})

describe('SVG 缓存', () => {
  test('超过条数上限时从最旧的删，刚写入的留下', () => {
    for (let at = 0; at < 65; at += 1) {
      keepSvg(`k${String(at)}`, `<svg id="${String(at)}"/>`)
    }

    expect(cachedSvg('k0')).toBeUndefined()
    expect(cachedSvg('k1')).toBe('<svg id="1"/>')
    expect(cachedSvg('k64')).toBe('<svg id="64"/>')
  })

  test('超过字符上限时从最旧的删，刚写入的留下', () => {
    const blob = 'x'.repeat(1_000_000)

    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      keepSvg(key, blob)
    }

    expect(cachedSvg('a')).toBeUndefined()
    expect(cachedSvg('b')).toBe(blob)
    expect(cachedSvg('e')).toBe(blob)
  })

  test('命中会刷新最近使用顺序：够老的那一条先被淘汰', () => {
    for (let at = 0; at < 64; at += 1) {
      keepSvg(`k${String(at)}`, 'x')
    }

    expect(cachedSvg('k0')).toBe('x')

    keepSvg('k64', 'x')

    expect(cachedSvg('k0')).toBe('x')
    expect(cachedSvg('k1')).toBeUndefined()
  })

  test('同键重复写入只算一份字符数，不把它自己的邻居挤掉', () => {
    const blob = 'x'.repeat(2_000_000)

    keepSvg('a', blob)
    keepSvg('b', blob)
    keepSvg('a', blob)

    expect(cachedSvg('a')).toBe(blob)
    expect(cachedSvg('b')).toBe(blob)
  })
})

describe('键', () => {
  test('键顺序不同、内容相同的两份颜色算出同一个键', () => {
    const straight = inksWith()
    const shuffled = Object.fromEntries(
      Object.entries(inksWith())
        .reverse()
        .map(([slot, value]) => [slot, value]),
    ) as DiagramInks

    expect(inksKey(shuffled)).toBe(inksKey(straight))
  })

  test('颜色不同或源码不同都不命中同一格', () => {
    const one = svgKey(inksWith(), 'graph TD;A-->B')

    expect(svgKey(inksWith({ mainBkg: 'rgb(1, 2, 3)' }), 'graph TD;A-->B')).not.toBe(one)
    expect(svgKey(inksWith(), 'graph TD;A-->C')).not.toBe(one)
    expect(svgKey(inksWith(), 'graph TD;A-->B')).toBe(one)
  })
})

describe('颜色缓存', () => {
  test('按主题各留一份：换主题不会拿着上一套颜色画', () => {
    keepInks('', inksWith({ mainBkg: 'rgb(5, 5, 5)' }))
    keepInks('dark', inksWith({ mainBkg: 'rgb(6, 6, 6)' }))

    expect(cachedInks('')?.mainBkg).toBe('rgb(5, 5, 5)')
    expect(cachedInks('dark')?.mainBkg).toBe('rgb(6, 6, 6)')
    expect(cachedInks('light')).toBeUndefined()
  })
})
