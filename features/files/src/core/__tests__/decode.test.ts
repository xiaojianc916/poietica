import { describe, expect, test } from 'bun:test'
import { decodeText } from '../decode'

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

function utf16le(text: string, bom = true): Uint8Array {
  const out = new Uint8Array((bom ? 2 : 0) + text.length * 2)
  if (bom) out.set([0xff, 0xfe])
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at)
    out[(bom ? 2 : 0) + at * 2] = unit & 0xff
    out[(bom ? 2 : 0) + at * 2 + 1] = unit >> 8
  }
  return out
}

function swap(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length)
  for (let at = 0; at + 1 < bytes.length; at += 2) {
    out[at] = bytes[at + 1] ?? 0
    out[at + 1] = bytes[at] ?? 0
  }
  return out
}

describe('decodeText', () => {
  test('UTF-8（含中文）原样', () => {
    expect(decodeText(utf8('你好\nworld\n'), false)).toEqual({ text: '你好\nworld\n', encoding: 'utf-8' })
  })

  test('UTF-8 BOM 去掉', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('a')])
    expect(decodeText(bytes, false)).toEqual({ text: 'a', encoding: 'utf-8' })
  })

  test('UTF-16 LE / BE 认 BOM（满是 NUL 也不判成二进制）', () => {
    expect(decodeText(utf16le('ab中'), false)).toEqual({ text: 'ab中', encoding: 'utf-16le' })
    expect(decodeText(swap(utf16le('ab中')), false)).toEqual({ text: 'ab中', encoding: 'utf-16be' })
  })

  test('开头一段有 NUL：二进制', () => {
    expect(decodeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), false)).toBeNull()
  })

  test('不是 UTF-8 的 8 位编码：宽松解码并标 lossy', () => {
    /* 「中文」的 GBK 字节 */
    const decoded = decodeText(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), false)
    expect(decoded?.encoding).toBe('lossy')
    expect(decoded?.text).toContain('\uFFFD')
  })

  test('截断的正文切在最后一个换行上：半个多字节字符不让整份判成乱码', () => {
    const whole = utf8('第一行\n第二行')
    const head = whole.subarray(0, whole.length - 1)
    expect(decodeText(head, true)).toEqual({ text: '第一行\n', encoding: 'utf-8' })
  })
})
