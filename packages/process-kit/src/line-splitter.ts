/** 把文本流切成行（去掉 \r\n / \n）。flush 输出最后不以换行结尾的残留内容 */
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
