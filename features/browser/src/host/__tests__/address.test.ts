import { describe, expect, test } from 'bun:test'
import { displayHost, isNavigableAddress, normalizeAddress } from '../address'

/*
 * BR-1：地址归一（07 页 §12G）。
 *
 * 判据与 legacy host.test.ts 的「裸主机名补 https，本地地址走 http，搜索词被拒」同一组，
 * 断言的六条就是 07 页点名的六条：localhost:5173、example.com、foo、a b、
 * javascript:alert(1)、file:///C:/x.html。
 */

describe('BR-1: normalizeAddress', () => {
  test('localhost:5173 → http://localhost:5173/', () => {
    expect(normalizeAddress('localhost:5173')).toBe('http://localhost:5173/')
  })

  test('example.com → https://example.com/', () => {
    expect(normalizeAddress('example.com')).toBe('https://example.com/')
  })

  test('foo → null（裸主机名不带点，更像没打完的搜索词）', () => {
    expect(normalizeAddress('foo')).toBeNull()
  })

  test('"a b" → null（搜索词不是地址）', () => {
    expect(normalizeAddress('a b')).toBeNull()
  })

  test('javascript:alert(1) → null（不是 http(s)/file 的 scheme）', () => {
    expect(normalizeAddress('javascript:alert(1)')).toBeNull()
  })

  test('file:///C:/x.html 通过（本地文件是要看的）', () => {
    expect(normalizeAddress('file:///C:/x.html')).toBe('file:///C:/x.html')
  })

  test('空串与纯空白 → null', () => {
    expect(normalizeAddress('')).toBeNull()
    expect(normalizeAddress('   ')).toBeNull()
  })

  test('带 scheme 的 http(s) 原样归一（补上路径与尾斜杠）', () => {
    expect(normalizeAddress('https://Example.COM/a?b=1')).toBe('https://example.com/a?b=1')
    expect(normalizeAddress('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173/')
  })

  test('带主机的 file: 是歧义写法，拒掉', () => {
    expect(normalizeAddress('file://host/share/a.txt')).toBeNull()
  })

  test('打错的地址（URL 解析不了）→ null', () => {
    expect(normalizeAddress('https://')).toBeNull()
  })
})

describe('地址判据的另两个入口', () => {
  test('displayHost 给主机名；不是 URL 的字符串原样交回', () => {
    expect(displayHost('https://a.example/x')).toBe('a.example')
    /* 解析得了、但没有主机的写法（about:、data:）拿到空串 —— 与内核的 URL.host 同此。 */
    expect(displayHost('about:blank')).toBe('')
    expect(displayHost('not a url')).toBe('not a url')
  })

  test('isNavigableAddress 只放行 http:、https:、about:', () => {
    expect(isNavigableAddress('https://a.example/')).toBe(true)
    expect(isNavigableAddress('about:blank')).toBe(true)
    expect(isNavigableAddress('file:///C:/x.html')).toBe(false)
    expect(isNavigableAddress('not a url')).toBe(false)
  })
})
