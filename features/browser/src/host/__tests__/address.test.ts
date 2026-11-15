import { describe, expect, test } from 'bun:test'
import { displayHost, isNavigableAddress, normalizeAddress } from '../address'

/* BR-1：地址归一。断言的是那六条规则本身，不是逐个例子各写一个用例。 */

describe('BR-1: normalizeAddress', () => {
  test('补 scheme 与尾斜杠；裸主机名、搜索词、非 http(s)/file 的 scheme 一律拒掉', () => {
    expect(normalizeAddress('localhost:5173')).toBe('http://localhost:5173/')
    expect(normalizeAddress('example.com')).toBe('https://example.com/')
    expect(normalizeAddress('https://Example.COM/a?b=1')).toBe('https://example.com/a?b=1')
    expect(normalizeAddress('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173/')
    expect(normalizeAddress('file:///C:/x.html')).toBe('file:///C:/x.html')

    expect(normalizeAddress('foo')).toBeNull()
    expect(normalizeAddress('a b')).toBeNull()
    expect(normalizeAddress('javascript:alert(1)')).toBeNull()
    expect(normalizeAddress('file://host/share/a.txt')).toBeNull()
    expect(normalizeAddress('https://')).toBeNull()
    expect(normalizeAddress('')).toBeNull()
    expect(normalizeAddress('   ')).toBeNull()
  })
})

describe('地址判据的另两个入口', () => {
  test('displayHost 给主机名；isNavigableAddress 只放行 http:、https:、about:', () => {
    expect(displayHost('https://a.example/x')).toBe('a.example')
    expect(displayHost('about:blank')).toBe('')
    expect(displayHost('not a url')).toBe('not a url')

    expect(isNavigableAddress('https://a.example/')).toBe(true)
    expect(isNavigableAddress('about:blank')).toBe(true)
    expect(isNavigableAddress('file:///C:/x.html')).toBe(false)
    expect(isNavigableAddress('not a url')).toBe(false)
  })
})
