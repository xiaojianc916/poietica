import { describe, expect, test } from 'bun:test'
import { createHeightCache, HEIGHT_CACHE_LIMIT } from '../height-cache'

describe('量过的高度', () => {
  test('H1 记下、读回；按最近使用淘汰，表长不过上限', () => {
    const cache = createHeightCache(2)
    cache.set('a', 100)
    cache.set('b', 200)
    expect(cache.get('a')).toBe(100)
    cache.set('c', 300)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(100)
    expect(cache.get('c')).toBe(300)
    cache.set('c', 320)
    expect(cache.get('c')).toBe(320)
    expect(cache.size()).toBe(2)
  })

  test('H2 缺省上限', () => {
    const cache = createHeightCache()
    for (let i = 0; i < HEIGHT_CACHE_LIMIT + 10; i++) cache.set(`k${i}`, i)
    expect(cache.size()).toBe(HEIGHT_CACHE_LIMIT)
    expect(cache.get('k0')).toBeUndefined()
    expect(cache.get(`k${HEIGHT_CACHE_LIMIT + 9}`)).toBe(HEIGHT_CACHE_LIMIT + 9)
  })
})
