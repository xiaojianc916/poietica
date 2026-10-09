const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32
const TIME_LEN = 10
const RANDOM_LEN = 16
const MAX_TIME = 2 ** 48 - 1

let lastTime = -1
const lastRandom = new Uint8Array(RANDOM_LEN) // 每个元素是 0..31 的一位 base32

function encodeTime(ms: number): string {
  let out = ''
  let t = ms
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[t % 32]! + out
    t = Math.floor(t / 32)
  }
  return out
}

function fillRandom(): void {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LEN))
  for (let i = 0; i < RANDOM_LEN; i++) lastRandom[i] = bytes[i]! & 31
}

/** 随机部分加 1；全部进位溢出时返回 false */
function incrementRandom(): boolean {
  for (let i = RANDOM_LEN - 1; i >= 0; i--) {
    const digit = lastRandom[i]!
    if (digit < 31) {
      lastRandom[i] = digit + 1
      return true
    }
    lastRandom[i] = 0
  }
  return false
}

/**
 * 单调 ULID（26 个字符）。前 10 位是毫秒时间戳，后 16 位随机。
 * 同一毫秒内（或系统时钟回拨时）随机部分递增，所以同一进程内生成的 id 严格递增，可以直接按字符串排序。
 */
export function createId(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) throw new RangeError(`无效的时间戳：${now}`)
  if (now > lastTime) {
    lastTime = now
    fillRandom()
  } else if (!incrementRandom()) {
    lastTime += 1
    fillRandom()
  }
  let random = ''
  for (let i = 0; i < RANDOM_LEN; i++) random += ENCODING[lastRandom[i]!]
  return encodeTime(lastTime) + random
}

const ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

export function isId(value: string): boolean {
  return ID_PATTERN.test(value)
}

/** 取出 id 中的毫秒时间戳 */
export function idTime(id: string): number {
  if (!isId(id)) throw new RangeError(`不是 ULID：${id}`)
  let t = 0
  for (let i = 0; i < TIME_LEN; i++) t = t * 32 + ENCODING.indexOf(id[i]!)
  return t
}
