/*
 * 字节 → 正文。纯函数，能单测。
 *
 * 判二进制只看开头一段有没有 NUL（git 与 VS Code 都是这条经验规则）；UTF-16 的正文满是 NUL，所以先认 BOM。
 * 不认识的 8 位编码（GBK 之类）按 UTF-8 宽松解码、标成 lossy：显示出几个替换符号比「打不开」有用，界面会注明。
 */

const SNIFF = 8000

export type DecodedText = {
  readonly text: string
  readonly encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'lossy'
}

function hasNul(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, SNIFF)
  for (let at = 0; at < end; at += 1) {
    if (bytes[at] === 0) return true
  }
  return false
}

/* 截断的正文切在最后一个换行上：半个多字节字符会让严格解码判成乱码。 */
function cutAtLine(bytes: Uint8Array): Uint8Array {
  const at = bytes.lastIndexOf(0x0a)
  return at <= 0 ? bytes : bytes.subarray(0, at + 1)
}

function utf16(bytes: Uint8Array, bigEndian: boolean): DecodedText {
  /* 截断在半个码元上时丢掉最后那一字节：与原来手写换序的边界一致，不让它变成替换符 */
  const body = bytes.subarray(2)
  const even = body.subarray(0, body.length - (body.length % 2))
  const text = new TextDecoder(bigEndian ? 'utf-16be' : 'utf-16le').decode(even)
  return { text, encoding: bigEndian ? 'utf-16be' : 'utf-16le' }
}

/** 二进制返回 null。`truncated` 为真时字节只是文件开头一段。 */
export function decodeText(bytes: Uint8Array, truncated: boolean): DecodedText | null {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16(bytes, false)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16(bytes, true)
  if (hasNul(bytes)) return null
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const body = truncated ? cutAtLine(bytes) : bytes
  const plain = bom ? body.subarray(3) : body
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(plain), encoding: 'utf-8' }
  } catch {
    return { text: new TextDecoder('utf-8').decode(plain), encoding: 'lossy' }
  }
}
