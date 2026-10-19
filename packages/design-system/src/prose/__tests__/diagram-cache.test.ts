import { beforeEach, describe, expect, test } from 'bun:test'
import { cachedSvg, keepSvg, resetDiagramCacheForTests, svgKey } from '../diagram-cache'

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
  /* 键只认源码：颜色以 var(--pele-*) 写进 svg，换主题走 CSS，不该让同一段源码再画一张。 */
  test('同一段源码同一个键，差一个字符就不同', () => {
    expect(svgKey('graph TD;A-->B')).toBe('graph TD;A-->B')
    expect(svgKey('graph TD;A-->B')).not.toBe(svgKey('graph TD;A-->C'))
  })
})
