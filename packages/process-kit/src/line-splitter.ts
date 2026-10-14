/**
 * 把文本流切成行（去掉 \r\n / \n）。flush 输出最后不以换行结尾的残留内容。
 *
 * **不要换成 `node:readline`**：它把 U+2028 / U+2029 也当行分隔符，而 `JSON.stringify` 不转义这两个
 * 字符 —— 一条正文里带它们的**合法** JSON-RPC 帧会被劈成两行（实测）。这里的 `indexOf('\n')` 只认
 * 真正的换行，与 `rpc/src/frame.ts` 的分帧口径一致。
 */
export class LineSplitter {
  private buffer = ''

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk
    let nl = this.buffer.indexOf('\n')
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
      nl = this.buffer.indexOf('\n')
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return
    const rest = this.buffer
    this.buffer = ''
    this.onLine(rest.endsWith('\r') ? rest.slice(0, -1) : rest)
  }
}
