import type { Logger } from '@poietica/foundation'

/**
 * Core 的**意外输出**：stderr 上的行（原生库的打印、被 stdout 守卫改道的杂散输出、Bun 崩溃栈、
 * 参数错误）与 stdout 上不带帧前缀的杂散文本。Core 自己的结构化日志不经过这里 —— 它直接写
 * logs/core.log，Host 只把少量意外输出记进 main.log，两个日志文件各只有一个写者（以前 Core 把
 * 日志序列化到 stderr、Host 在主线程逐行 parse 再 writeSync，一条日志两个进程各处理一遍）。
 */
export interface CoreOutputSink {
  line(text: string): void
  stray(text: string): void
}

/** 单条意外输出最多记多少字符：一次失控的打印不该把 main.log 撑满 */
const MAX_CHARS = 2_000

export function createCoreOutputSink(logger: Logger): CoreOutputSink {
  const log = logger.child({ scope: 'core-output' })
  return {
    line(text) {
      const trimmed = text.trim()
      if (trimmed !== '') log.warn('core stderr', { line: trimmed.slice(0, MAX_CHARS) })
    },
    stray(text) {
      log.warn('core stdout stray', { text: text.slice(0, MAX_CHARS) })
    },
  }
}
