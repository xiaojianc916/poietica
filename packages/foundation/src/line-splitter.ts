/**
 * 把文本流切成行（去掉 \r\n / \n）。flush 输出最后不以换行结尾的残留内容。
 *
 * **不要换成 `node:readline`**：它把 U+2028 / U+2029 也当行分隔符，而 `JSON.stringify` 不转义这两个
 * 字符 —— 一条正文里带它们的**合法** JSON-RPC 帧会被劈成两行（实测）。这里的 `indexOf('\n')` 只认
 * 真正的换行。`rpc/src/frame.ts` 的分帧也走这个类，两边口径天然一致（一源）。
 *
 * **线性时间**：未成行的残片按 chunk 原样存进数组，只在遇到换行时 join 一次；每个 chunk 只从上次的
 * 位置往后扫。旧写法每来一个 chunk 就 `buffer += chunk` 再从 0 开始 `indexOf` / `slice`，一条 N 字节的
 * 大帧被管道切成 k 片时是 O(N·k)：V8 上 16MB 的帧（64KB 一片）要 1.2 秒，32MB 要 4.7 秒 —— 而 Host
 * 的解码跑在 Electron 主线程上。
 *
 * `maxLineLength`：一行超长时调一次 `onOverflow`（带开头 200 字符的样本），然后**丢弃到下一个换行为止**。
 * 不能只清空缓冲：那样超长行的后半截会在下一个换行处被当成一行交出去（变成一条巨大的乱码 stray）。
 */
export interface LineSplitterOptions {
  readonly maxLineLength?: number
  readonly onOverflow?: (head: string) => void
}

const OVERFLOW_SAMPLE_CHARS = 200

export class LineSplitter {
  private pending: string[] = []
  private pendingLength = 0
  /** 正在丢弃一条超长行，直到下一个换行 */
  private discarding = false

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly options: LineSplitterOptions = {},
  ) {}

  push(chunk: string): void {
    let start = 0
    let nl = chunk.indexOf('\n')
    while (nl !== -1) {
      this.endLine(chunk.slice(start, nl))
      start = nl + 1
      nl = chunk.indexOf('\n', start)
    }
    if (start >= chunk.length || this.discarding) return
    const rest = start === 0 ? chunk : chunk.slice(start)
    if (this.exceeds(this.pendingLength + rest.length)) {
      this.overflow(rest)
      return
    }
    this.pending.push(rest)
    this.pendingLength += rest.length
  }

  flush(): void {
    const discarding = this.discarding
    const rest = this.pending.join('')
    this.pending = []
    this.pendingLength = 0
    this.discarding = false
    if (!discarding && rest.length > 0) this.emit(rest)
  }

  /** 遇到换行：交出 pending + piece 这一行（丢弃态下只是结束丢弃），然后清空 pending */
  private endLine(piece: string): void {
    if (this.discarding) {
      this.discarding = false
    } else if (this.exceeds(this.pendingLength + piece.length)) {
      this.overflow(piece)
      this.discarding = false
    } else {
      this.emit(this.pending.length === 0 ? piece : this.pending.join('') + piece)
    }
    this.pending = []
    this.pendingLength = 0
  }

  private emit(line: string): void {
    this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
  }

  private exceeds(length: number): boolean {
    const max = this.options.maxLineLength
    return max !== undefined && length > max
  }

  /** 报告一次超长并进入丢弃态；样本取自行首 */
  private overflow(tail: string): void {
    const head = this.pending.length === 0 ? tail : (this.pending[0] ?? '')
    this.options.onOverflow?.(head.slice(0, OVERFLOW_SAMPLE_CHARS))
    this.pending = []
    this.pendingLength = 0
    this.discarding = true
  }
}
