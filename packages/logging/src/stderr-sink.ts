import type { LogSink } from './logger'
import { redactSecrets } from './redact'

/** Core 专用：每条记录一行 JSON 写到 stderr。Host 的 CoreLogSink 逐行收集写入 logs/core.log（06 页 §4.10） */
export function stderrJsonSink(stream: { write(text: string): unknown } = process.stderr): LogSink {
  return {
    write(record) {
      try {
        stream.write(`${JSON.stringify(redactSecrets(record))}\n`)
      } catch {
        // stderr 已关闭（Host 已退出）：无处可写
      }
    },
  }
}
