/**
 * 只保留最近 limit 个 UTF-16 码元（近似字节数；用于重放，不需要精确）。
 *
 * 尾部超出时按**码元**从最老的一头裁：整块装不下就整块扔，只有当前最老的一块
 * 仍跨过上限才切它（TM-7：push 'abcdef'、'ghijkl'、limit 10 → 'cdefghijkl'）。
 *
 * 切的位置往后找到第一个换行，从换行**之后**开始留（R-08-15）：重放的第一行若从
 * 半截的 ANSI 转义序列或半截的宽字符开始，画面就是乱的；宁可多丢半行。整段都没有
 * 换行时（例如没有行结构的输出）仍按码元切 —— 否则重放会被清空。
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
      this.trimHead(excess)
      break
    }
    if (this.size > this.limit) {
      this.trimHead(this.size - this.limit)
    }
  }

  /** 从最老的一块里扔掉至少 count 个码元，但切点落在行首 */
  private trimHead(count: number): void {
    const first = this.chunks[0]!
    const brk = first.indexOf('\n', count)
    const cut = brk === -1 ? count : brk + 1
    this.chunks[0] = first.slice(cut)
    this.size -= cut
  }

  read(): string {
    return this.chunks.join('')
  }
}
