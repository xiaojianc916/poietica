import type { LogSink } from './logger'
import { redactSecrets } from './redact'

/**
 * 每条记录一行 JSON 写到 stderr（探针脚本等短命进程用）。Core 的 serve 不用它：Core 自己写 logs/core.log，
 * stderr 只留给意外输出（Host 记进 main.log，见 host-kernel/src/core-output.ts）。
 */
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
