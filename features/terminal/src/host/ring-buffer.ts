/**
 * 只保留最近 limit 个 UTF-16 码元（近似字节数；用于重放，不需要精确）。
 *
 * 尾部超出时按**码元**从最老的一头裁：整块装不下就整块扔，只有当前最老的一块
 * 仍跨过上限才切它（TM-7：push 'abcdef'、'ghijkl'、limit 10 → 'cdefghijkl'）。
 */
export class RingBuffer {
  private chunks: string[] = []
  private size = 0
  constructor(private readonly limit: number) {}

  push(s: string): void {
    this.chunks.push(s)
    this.size += s.length
    while (this.size > this.limit && this.chunks.length > 1) {
      const first = this.chunks[0]!
      const excess = this.size - this.limit
      if (first.length <= excess) {
        this.chunks.shift()
        this.size -= first.length
        continue
      }
      this.chunks[0] = first.slice(excess)
      this.size -= excess
      break
    }
    if (this.size > this.limit) {
      const only = this.chunks[0]!
      this.chunks[0] = only.slice(only.length - this.limit)
      this.size = this.limit
    }
  }

  read(): string {
    return this.chunks.join('')
  }
}
